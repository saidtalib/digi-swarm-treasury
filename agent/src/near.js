// Thin helpers around near-api-js v7 for the demo.
// Keys live in ../.keys/ (git-ignored). Nothing here ever prints a private key.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, actions, getTransactionLastResult, nearToYocto, yoctoToNear } from 'near-api-js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..', '..');
export const KEY_DIR = path.join(ROOT, '.keys');
export const DEPLOYMENT_FILE = path.join(ROOT, 'deployment.json');
export const NETWORK = process.env.NEAR_NETWORK || 'testnet';
export const RPC_URL = process.env.NEAR_RPC_URL || 'https://rpc.testnet.near.org';
export const EXPLORER = process.env.NEAR_EXPLORER || 'https://testnet.nearblocks.io';

if (NETWORK !== 'testnet') {
  // Hard rule for this demo: it signs only on testnet. Mainnet is read-only (1Click dry quotes).
  throw new Error('This demo signs transactions on testnet only. Unset NEAR_NETWORK or set it to testnet.');
}

export const provider = new JsonRpcProvider({ url: RPC_URL });
export { nearToYocto, yoctoToNear, actions };

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const fmt = (yocto) => `${Number(yoctoToNear(BigInt(yocto))).toFixed(4)} NEAR`;
export const txLink = (hash) => `${EXPLORER}/txns/${hash}`;

export function saveKey(accountId, keyPair, kind) {
  fs.mkdirSync(KEY_DIR, { recursive: true, mode: 0o700 });
  const file = path.join(KEY_DIR, `${accountId}.json`);
  fs.writeFileSync(file, JSON.stringify({ account_id: accountId, kind, public_key: keyPair.getPublicKey().toString(), private_key: keyPair.toString() }), { mode: 0o600 });
}

export function loadKey(accountId) {
  const file = path.join(KEY_DIR, `${accountId}.json`);
  if (!fs.existsSync(file)) throw new Error(`No local key for ${accountId} in .keys/. Run "npm run setup" first.`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function accountFor(accountId) {
  const k = loadKey(accountId);
  return new Account(accountId, provider, KeyPairSigner.fromSecretKey(k.private_key));
}

export function loadDeployment() {
  if (!fs.existsSync(DEPLOYMENT_FILE)) throw new Error('deployment.json not found. Run "npm run setup" first.');
  return JSON.parse(fs.readFileSync(DEPLOYMENT_FILE, 'utf8'));
}

export async function view(contractId, method, args = {}) {
  return provider.callFunction({ contractId, method, args });
}

/** Signs a function call with the caller's (usually function-call-only) key. Returns { result, hash }. */
export async function call(signerId, contractId, methodName, args = {}, { deposit = 0n, gasT = 50n } = {}) {
  const acct = accountFor(signerId);
  const res = await acct.signAndSendTransaction({
    receiverId: contractId,
    actions: [actions.functionCall(methodName, args, gasT * 10n ** 12n, BigInt(deposit))],
    waitUntil: 'EXECUTED_OPTIMISTIC',
  });
  return { result: getTransactionLastResult(res), hash: res.transaction.hash ?? res.transaction_outcome?.id };
}

export function newKeyPair() {
  return KeyPair.fromRandom('ed25519');
}

export async function accountExists(accountId) {
  try {
    await provider.viewAccount({ accountId });
    return true;
  } catch {
    return false;
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function log(tag, msg) {
  const colors = { owner: 35, coord: 36, worker: 33, client: 32, treasury: 34, guard: 31, info: 37, ok: 32 };
  const c = colors[tag] || 37;
  console.log(`\x1b[${c}m[${tag.padEnd(8)}]\x1b[0m ${msg}`);
}
