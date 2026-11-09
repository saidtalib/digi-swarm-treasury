// Creates a fresh, self-contained deployment on NEAR testnet:
//   HQ account (contract) + owner / coordinator / client / 3 worker sub-accounts.
// Coordinator and workers get FUNCTION-CALL-ONLY keys limited to the contract and to their methods,
// so the agents can never transfer NEAR or change the policy themselves.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Account, KeyPairSigner } from 'near-api-js';
import { provider, actions, saveKey, loadKey, newKeyPair, accountExists, accountFor, call, log, fmt, txLink, ROOT, KEY_DIR, DEPLOYMENT_FILE, sleep, nearToYocto } from './near.js';
import { POLICY, WORKERS, COORD_METHODS, WORKER_METHODS, KNOWN_SCAM, Y } from './config.js';
import { deriveEvmAddress } from './chainsig.js';

const force = process.argv.includes('--force');
if (fs.existsSync(DEPLOYMENT_FILE) && !force) {
  log('info', `deployment.json already exists (${JSON.parse(fs.readFileSync(DEPLOYMENT_FILE)).contract}). Use --force for a new one.`);
  process.exit(0);
}

const WASM = path.join(ROOT, 'contract', 'res', 'digi_swarm_treasury.wasm');
const txs = {};

async function getHq() {
  const hq = process.env.HQ_ACCOUNT;
  if (hq) {
    const local = path.join(KEY_DIR, `${hq}.json`);
    const legacy = path.join(os.homedir(), '.near-credentials', 'testnet', `${hq}.json`);
    if (!fs.existsSync(local) && fs.existsSync(legacy)) {
      const k = JSON.parse(fs.readFileSync(legacy, 'utf8'));
      fs.mkdirSync(KEY_DIR, { recursive: true, mode: 0o700 });
      fs.writeFileSync(local, JSON.stringify({ account_id: hq, kind: 'full-access', public_key: k.public_key, private_key: k.private_key }), { mode: 0o600 });
    }
    loadKey(hq);
    log('info', `using existing HQ account ${hq}`);
    return hq;
  }
  const id = `digi-swarm-${crypto.randomBytes(3).toString('hex')}.testnet`;
  const kp = newKeyPair();
  log('info', `creating ${id} with the NEAR testnet faucet (helper.nearprotocol.com) ...`);
  const r = await fetch('https://helper.nearprotocol.com/account', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ newAccountId: id, newAccountPublicKey: kp.getPublicKey().toString() }),
  });
  if (!r.ok) throw new Error(`faucet failed (${r.status}): ${await r.text()}. Create a testnet account manually and rerun with HQ_ACCOUNT=<id>.`);
  saveKey(id, kp, 'full-access');
  for (let i = 0; i < 20 && !(await accountExists(id)); i++) await sleep(1500);
  return id;
}

async function createSub(hq, prefix, near, key) {
  const id = `${prefix}.${hq}`;
  if (await accountExists(id)) {
    log('info', `${id} exists, skipping`);
    return id;
  }
  const kp = newKeyPair();
  const pk = kp.getPublicKey();
  const keyAction =
    key.type === 'full'
      ? actions.addFullAccessKey(pk)
      : actions.addFunctionCallAccessKey(pk, hq, key.methods, BigInt(nearToYocto(String(key.allowance))));
  const res = await accountFor(hq).signAndSendTransaction({
    receiverId: id,
    actions: [actions.createAccount(), actions.transfer(BigInt(nearToYocto(String(near)))), keyAction],
    waitUntil: 'FINAL',
  });
  saveKey(id, kp, key.type === 'full' ? 'full-access' : `function-call: ${hq} [${key.methods.join(', ')}]`);
  txs[`create_${prefix}`] = res.transaction.hash;
  log('info', `created ${id} (${key.type === 'full' ? 'full-access key' : `function-call key -> ${hq}: ${key.methods.join(', ')}`})`);
  return id;
}

const hq = await getHq();
const state = await provider.viewAccount({ accountId: hq });
log('info', `HQ balance ${fmt(state.amount)}`);

const owner = await createSub(hq, 'owner', 1.0, { type: 'full' });
const coord = await createSub(hq, 'coordinator', 0.25, { type: 'fc', methods: COORD_METHODS, allowance: 0.5 });
const client = await createSub(hq, 'client', 1.2, { type: 'full' });
const workers = [];
for (const w of WORKERS) {
  const id = await createSub(hq, w.prefix, 0.12, { type: 'fc', methods: WORKER_METHODS, allowance: 0.1 });
  workers.push({ ...w, account: id });
}

// Deploy + init in one transaction.
const code = fs.readFileSync(WASM);
const policy = { ...POLICY, ledger: owner };
let already = false;
try { await provider.callFunction({ contractId: hq, method: 'get_stats', args: {} }); already = true; } catch {}
if (already) throw new Error(`${hq} already has an initialised contract. Use a new HQ account (unset HQ_ACCOUNT to get one from the faucet).`);
const dep = await accountFor(hq).signAndSendTransaction({
  receiverId: hq,
  actions: [
    actions.deployContract(new Uint8Array(code)),
    actions.functionCall('new', { owner, coordinator: coord, policy }, 100n * 10n ** 12n, 0n),
  ],
  waitUntil: 'FINAL',
});
txs.deploy_and_init = dep.transaction.hash;
log('owner', `contract deployed to ${hq} and initialised: owner=${owner}, coordinator=${coord}`);

// Chain Signatures: each worker's Base/Arbitrum payout address is derived from its NEAR account by the MPC network.
for (const w of workers) {
  w.evm = await deriveEvmAddress(w.account);
  log('worker', `${w.account} controls ${w.evm} on EVM chains via NEAR Chain Signatures`);
}

// Owner sets the constraints: allowlist the workers' cross-chain payout addresses, block a known scam account, fund the treasury.
for (const w of workers) {
  const r = await call(owner, hq, 'allow_destination', { dest: `${w.payoutChain}:${w.evm}` });
  txs[`allow_${w.prefix}`] = r.hash;
}
txs.block_scam = (await call(owner, hq, 'block_destination', { dest: `near:${KNOWN_SCAM}` })).hash;
txs.fund = (await call(owner, hq, 'fund_treasury', {}, { deposit: Y(0.6) })).hash;
log('owner', `allowlisted ${workers.length} payout addresses, blocked near:${KNOWN_SCAM}, funded treasury with 0.6 NEAR`);

// Coordinator registers the worker agents.
for (const w of workers) {
  const r = await call(coord, hq, 'register_worker', { account: w.account, role: w.role });
  txs[`register_${w.prefix}`] = r.hash;
}
log('coord', `registered workers: ${workers.map((w) => w.account).join(', ')}`);

const deployment = {
  network: 'testnet',
  contract: hq,
  owner,
  coordinator: coord,
  client,
  workers: workers.map(({ prefix, role, payoutChain, account, evm }) => ({ prefix, role, payoutChain, account, evm })),
  policy,
  created_at: new Date().toISOString(),
  txs,
};
fs.writeFileSync(DEPLOYMENT_FILE, JSON.stringify(deployment, null, 2));
log('ok', `wrote deployment.json. Deploy tx: ${txLink(txs.deploy_and_init)}`);
