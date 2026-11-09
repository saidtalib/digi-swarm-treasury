// One command for judges: setup (if needed) -> swarm business cycle -> red-team run -> owner approval -> verify.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { DEPLOYMENT_FILE } from './near.js';

const step = (title, args) => {
  console.log(`\n\x1b[1m=== ${title} ===\x1b[0m`);
  const r = spawnSync(process.execPath, args, { stdio: 'inherit', env: process.env });
  if (r.status !== 0) { console.error(`step failed: ${title}`); process.exit(r.status || 1); }
};
if (!fs.existsSync(DEPLOYMENT_FILE)) step('1/5 setup: faucet account, sub-accounts, scoped keys, deploy contract', ['src/setup.js']);
else console.log('deployment.json found, skipping setup');
step('2/5 swarm: scout -> bid -> award -> deliver -> get paid -> settle cross-chain', ['src/swarm.js']);
step('3/5 red team: prompt-injected agent tries to drain the treasury', ['src/attack.js']);
step('4/5 owner reviews the queue', ['src/owner.js', 'pending']);
step('5/5 anyone verifies the audit chain', ['src/verify.js']);
console.log('\nNext: npm run dashboard  ->  http://localhost:8787');
