// Anyone can re-verify the swarm's audit log from public view calls: no keys needed.
//   npm run verify                      -> the contract in deployment.json
//   npm run verify -- digi-swarm-hq.testnet
import fs from 'node:fs';
import { view, sha256, log, DEPLOYMENT_FILE } from './near.js';

const contract = process.argv[2] || (fs.existsSync(DEPLOYMENT_FILE) ? JSON.parse(fs.readFileSync(DEPLOYMENT_FILE)).contract : 'digi-swarm-hq.testnet');
let head = '0'.repeat(64);
let from = 0;
let total = 1;
let onchainHead = '';
const counts = {};
const blocked = [];
while (from < total) {
  const page = await view(contract, 'get_audit', { from_index: from, limit: 100 });
  total = Number(page.total);
  onchainHead = page.head;
  for (const e of page.events) {
    head = sha256(head + e);
    const ev = JSON.parse(e);
    counts[ev.event] = (counts[ev.event] || 0) + 1;
    const dec = ev.data?.[0]?.decision;
    if (dec && !['executed', 'authorized'].includes(dec)) blocked.push(`${ev.event} -> ${dec}`);
  }
  from += page.events.length;
  if (!page.events.length) break;
}
log('info', `contract ${contract}: ${total} audit events`);
for (const [k, v] of Object.entries(counts)) log('info', `  ${k.padEnd(18)} ${v}`);
log('info', `decisions that were stopped by policy: ${blocked.length}`);
for (const b of blocked) log('guard', `  ${b}`);
if (head === onchainHead) log('ok', `hash chain OK: recomputed head ${head.slice(0, 16)}... matches on-chain head`);
else { log('guard', `MISMATCH: recomputed ${head} vs on-chain ${onchainHead}`); process.exit(1); }
