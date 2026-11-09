// The human owner's console: review queued payouts, approve/reject, pause, change the allowlist.
// Uses the owner's full-access key from .keys/ (in production: a hardware wallet / multisig).
import { call, view, loadDeployment, log, fmt, txLink } from './near.js';

const d = loadDeployment();
const C = d.contract;
const [cmd, arg] = process.argv.slice(2);

switch (cmd) {
  case 'pending': {
    const p = await view(C, 'get_pending');
    if (!p.length) log('owner', 'no payouts waiting');
    for (const x of p) log('owner', `#${x.id} ${x.status.padEnd(8)} ${fmt(x.amount)} -> ${x.to}  (${x.reason}; "${x.memo}")`);
    break;
  }
  case 'approve':
  case 'reject': {
    const r = await call(d.owner, C, `${cmd}_pending`, { id: Number(arg) });
    log('owner', `${cmd}d #${arg}  ${txLink(r.hash)}`);
    break;
  }
  case 'pause':
  case 'unpause': {
    const r = await call(d.owner, C, 'set_paused', { paused: cmd === 'pause' });
    log('owner', `${cmd}d the swarm treasury  ${txLink(r.hash)}`);
    break;
  }
  case 'allow':
  case 'block': {
    const r = await call(d.owner, C, `${cmd === 'allow' ? 'allow' : 'block'}_destination`, { dest: arg });
    log('owner', `${cmd} ${arg}  ${txLink(r.hash)}`);
    break;
  }
  default:
    console.log('usage: npm run owner -- pending | approve <id> | reject <id> | pause | unpause | allow <chain:addr> | block <chain:addr>');
}
