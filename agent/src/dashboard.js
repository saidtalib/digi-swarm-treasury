// Read-only dashboard: http://localhost:8787  (npm run dashboard [-- <contract.testnet>])
// Renders the contract's public view calls. No keys are loaded.
import http from 'node:http';
import fs from 'node:fs';
import { view, sha256, fmt, DEPLOYMENT_FILE, EXPLORER } from './near.js';

const contract = process.argv[2] || (fs.existsSync(DEPLOYMENT_FILE) ? JSON.parse(fs.readFileSync(DEPLOYMENT_FILE)).contract : 'digi-swarm-hq.testnet');
const PORT = Number(process.env.PORT || 8787);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const short = (a) => (a && a.length > 34 ? `${a.slice(0, 14)}…${a.slice(-12)}` : a);
const badge = (t) => {
  const cls = /^(executed|authorized|Paid|approved)/.test(t) ? 'ok' : /^(blocked|rejected)/.test(t) ? 'bad' : /^queued/.test(t) ? 'warn' : 'n';
  return `<span class="b ${cls}">${esc(t)}</span>`;
};

async function render() {
  const [s, p, workers, jobs, pending, intents, allow, block] = await Promise.all([
    view(contract, 'get_stats'), view(contract, 'get_policy'), view(contract, 'get_workers'), view(contract, 'get_jobs', { limit: 50 }),
    view(contract, 'get_pending'), view(contract, 'get_intents'), view(contract, 'get_allowlist'), view(contract, 'get_blocklist'),
  ]);
  const events = [];
  let head = '0'.repeat(64);
  for (let from = 0; from < Number(s.audit_len); from += 100) {
    const page = await view(contract, 'get_audit', { from_index: from, limit: 100 });
    for (const e of page.events) { head = sha256(head + e); events.push(JSON.parse(e)); }
  }
  const chainOk = head === s.audit_head;
  const stopped = events.filter((e) => e.data?.[0]?.decision && !/^(executed|authorized)/.test(e.data[0].decision)).length;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="15"><title>Digi Swarm Treasury</title>
<style>
body{font-family:Inter,system-ui,sans-serif;background:#0b0f14;color:#e6edf3;margin:0;padding:24px 32px}
h1{margin:0 0 4px;font-size:24px}h2{font-size:15px;color:#9fb3c8;margin:26px 0 8px;text-transform:uppercase;letter-spacing:.06em}
.sub{color:#8b9bb0;font-size:13px}a{color:#7cc4ff}
.cards{display:grid;grid-template-columns:repeat(6,1fr);gap:12px;margin-top:18px}
.card{background:#121923;border:1px solid #1f2a37;border-radius:10px;padding:12px 14px}.card .k{color:#8b9bb0;font-size:12px}.card .v{font-size:20px;font-weight:600;margin-top:4px}
table{width:100%;border-collapse:collapse;font-size:13px;background:#121923;border-radius:10px;overflow:hidden}
th,td{padding:7px 10px;border-bottom:1px solid #1f2a37;text-align:left;vertical-align:top}th{color:#8b9bb0;font-weight:500}
.b{padding:2px 8px;border-radius:999px;font-size:12px;white-space:nowrap}.ok{background:#12351f;color:#5fe08a}.bad{background:#3d1517;color:#ff7b7b}.warn{background:#3a2d0c;color:#ffcb5c}.n{background:#1f2a37;color:#c9d6e3}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:18px}code{color:#c9d6e3;font-size:12px}
</style></head><body>
<h1>Digi Swarm Treasury</h1>
<div class="sub">Contract <a href="${EXPLORER}/address/${contract}">${contract}</a> on NEAR testnet · owner ${esc(s.owner)} · coordinator ${esc(s.coordinator)} · auto-refresh 15s</div>
<div class="cards">
<div class="card"><div class="k">Treasury</div><div class="v">${fmt(s.treasury_balance)}</div></div>
<div class="card"><div class="k">Earned from clients</div><div class="v">${fmt(s.total_earned)}</div></div>
<div class="card"><div class="k">Paid out (policy-approved)</div><div class="v">${fmt(s.total_paid_out)}</div></div>
<div class="card"><div class="k">Swept to owner ledger</div><div class="v">${fmt(s.total_swept)}</div></div>
<div class="card"><div class="k">Actions stopped by policy</div><div class="v">${stopped}</div></div>
<div class="card"><div class="k">Audit chain (${s.audit_len} events)</div><div class="v">${chainOk ? '<span class="b ok">verified</span>' : '<span class="b bad">MISMATCH</span>'}</div></div>
</div>
<h2>Owner policy (set by the human)</h2>
<table><tr><th>Max payout / tx</th><th>Daily cap</th><th>Sweep above → keep</th><th>Ledger</th><th>Max intent</th><th>Paused</th></tr>
<tr><td>${fmt(p.max_payout_per_tx)}</td><td>${fmt(p.daily_cap)}</td><td>${fmt(p.sweep_threshold)} → ${fmt(p.sweep_keep)}</td><td>${esc(p.ledger)}</td><td>$${(Number(p.max_intent_usd_cents) / 100).toFixed(2)}</td><td>${p.paused ? badge('blocked: paused') : badge('executed: live')}</td></tr></table>
<div class="grid2"><div><h2>Allowlist</h2><table>${allow.map((a) => `<tr><td><code>${esc(a)}</code></td></tr>`).join('') || '<tr><td>—</td></tr>'}</table></div>
<div><h2>Blocklist</h2><table>${block.map((a) => `<tr><td><code>${esc(a)}</code></td></tr>`).join('') || '<tr><td>—</td></tr>'}</table></div></div>
<h2>Worker agents (sub-accounts, function-call keys only)</h2>
<table><tr><th>Account</th><th>Role</th><th>Jobs</th><th>Reputation</th><th>Earned</th></tr>
${workers.map((w) => `<tr><td>${esc(w.account)}</td><td>${esc(w.role)}</td><td>${w.jobs_done}</td><td>${w.reputation}</td><td>${fmt(w.earned)}</td></tr>`).join('')}</table>
<h2>Jobs (auctioned on-chain)</h2>
<table><tr><th>Job</th><th>Source</th><th>Reward</th><th>Bids</th><th>Winner @ price</th><th>Deliverable sha256</th><th>Status</th></tr>
${jobs.map((j) => `<tr><td>${esc(j.title)}<br><code>${esc(j.id)}</code></td><td><code>${esc(short(j.source))}</code></td><td>${fmt(j.reward)}</td><td>${j.bids.map((b) => `${esc(b.worker.split('.')[0])}: ${fmt(b.price)} (${b.confidence_pct}%)`).join('<br>')}</td><td>${j.assigned_to ? `${esc(j.assigned_to.split('.')[0])} @ ${fmt(j.winning_price)}` : '—'}</td><td><code>${esc(j.deliverable_sha256 ? j.deliverable_sha256.slice(0, 16) + '…' : '—')}</code></td><td>${badge(j.status)}</td></tr>`).join('')}</table>
<div class="grid2"><div><h2>NEAR Intents payouts (gated by the contract)</h2>
<table><tr><th>#</th><th>Destination</th><th>USD</th><th>Decision</th></tr>
${intents.map((i) => `<tr><td>${i.id}</td><td><code>${esc(i.chain)}:${esc(short(i.recipient))}</code></td><td>$${(Number(i.amount_usd_cents) / 100).toFixed(2)}</td><td>${badge(i.status)}</td></tr>`).join('')}</table></div>
<div><h2>Waiting for the owner</h2>
<table><tr><th>#</th><th>To</th><th>Amount</th><th>Reason</th><th>Status</th></tr>
${pending.map((x) => `<tr><td>${x.id}</td><td>${esc(x.to)}</td><td>${fmt(x.amount)}</td><td>${esc(x.reason)}</td><td>${badge(x.status)}</td></tr>`).join('') || '<tr><td colspan=5>—</td></tr>'}</table></div></div>
<h2>Audit log (latest 20 of ${events.length}, sha256 hash-chained)</h2>
<table><tr><th>#</th><th>Block</th><th>Event</th><th>Data</th></tr>
${events.slice(-20).reverse().map((e) => `<tr><td>${e.seq}</td><td>${e.block}</td><td>${esc(e.event)}</td><td>${e.data?.[0]?.decision ? badge(e.data[0].decision) + ' ' : ''}<code>${esc(JSON.stringify(e.data?.[0] ?? {})).slice(0, 220)}</code></td></tr>`).join('')}</table>
<p class="sub">Head: <code>${s.audit_head}</code></p>
</body></html>`;
}

http.createServer(async (req, res) => {
  try {
    const html = await render();
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end(`error: ${e.message}`);
  }
}).listen(PORT, () => console.log(`Digi Swarm Treasury dashboard for ${contract}: http://localhost:${PORT}`));
