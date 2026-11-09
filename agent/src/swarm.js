// One full business cycle of the swarm on NEAR testnet:
// scout -> coordinator posts jobs -> workers bid with their own keys -> contract picks winners ->
// winners deliver (sha256 on-chain) -> client pays -> contract splits revenue -> treasury settles
// worker USDC payouts cross-chain through NEAR Intents, but only after the contract authorises them.
import fs from 'node:fs';
import path from 'node:path';
import { call, view, loadDeployment, log, fmt, sha256, txLink, ROOT, nearToYocto } from './near.js';
import { fetchJobs, rank, fit } from './scout.js';
import { REWARD_NEAR_PER_USD, MAX_JOB_REWARD_NEAR } from './config.js';
import { draftDeliverable } from './llm.js';
import { dryQuote } from './intents.js';

const d = loadDeployment();
const C = d.contract;
const OUT = path.join(ROOT, 'out');
fs.mkdirSync(path.join(OUT, 'deliverables'), { recursive: true });
const run = { started_at: new Date().toISOString(), contract: C, jobs: [], intents: [] };
const N = Number(process.argv.find((a) => a.startsWith('--jobs='))?.split('=')[1] || 3);

// 1. Scout
const { source, jobs } = await fetchJobs();
const picked = rank(jobs.filter((j) => !j.synthetic), N);
log('coord', `scouted ${jobs.length} open jobs (${source}); picked ${picked.length}`);

for (const { job, usd } of picked) {
  const rewardNear = Math.min(usd * REWARD_NEAR_PER_USD, MAX_JOB_REWARD_NEAR);
  const reward = nearToYocto(rewardNear.toFixed(6)).toString();
  const jobId = `${String(job.jobId).slice(0, 8)}-${Date.now().toString(36)}`;
  const rec = { jobId, marketJobId: job.jobId, title: job.title, usd, reward, txs: {} };

  // 2. Coordinator posts the job on-chain
  rec.txs.post = (await call(d.coordinator, C, 'post_job', { job_id: jobId, title: job.title, source: `market.near.ai:${job.jobId}`, reward })).hash;
  log('coord', `posted "${job.title.slice(0, 50)}" ($${usd}) as ${jobId}, reward ${fmt(reward)}`);

  // 3. Each worker agent decides on its own whether and how much to bid, and signs with its own key
  const f = fit(job);
  for (const w of d.workers) {
    const s = f.scores[w.role] || 0;
    if (s <= 0) { log('worker', `${w.prefix.padEnd(10)} skips (no skill match)`); continue; }
    const margin = { research: 0.62, code: 0.7, writing: 0.55 }[w.role] + 0.25 * (1 - s);
    const price = (BigInt(reward) * BigInt(Math.round(Math.min(margin, 0.95) * 1000))) / 1000n;
    const confidence = Math.round(40 + 60 * s);
    const eta = Math.round(4 + 20 * (1 - s));
    const r = await call(w.account, C, 'submit_bid', { job_id: jobId, price: price.toString(), confidence_pct: confidence, eta_hours: eta });
    rec.txs[`bid_${w.prefix}`] = r.hash;
    log('worker', `${w.prefix.padEnd(10)} bids ${fmt(price)} (confidence ${confidence}%, eta ${eta}h)`);
  }

  // 4. The contract picks the winner (confidence x reputation / price)
  const { result: winner, hash: closeHash } = await call(d.coordinator, C, 'close_auction', { job_id: jobId });
  rec.txs.close = closeHash;
  rec.winner = winner;
  const w = d.workers.find((x) => x.account === winner);
  log('coord', `contract awarded ${jobId} to ${winner}`);

  // 5. Winner delivers; only the hash goes on-chain
  const draft = await draftDeliverable({ role: w.role, job });
  const file = path.join(OUT, 'deliverables', `${jobId}.md`);
  fs.writeFileSync(file, draft.text);
  const digest = sha256(draft.text);
  rec.deliverable = { file: path.relative(ROOT, file), sha256: digest, engine: draft.engine };
  rec.txs.deliver = (await call(winner, C, 'deliver', { job_id: jobId, deliverable_sha256: digest })).hash;
  log('worker', `${w.prefix} delivered ${path.basename(file)} sha256=${digest.slice(0, 16)}... (${draft.engine})`);

  // 6. Client (stand-in for the marketplace escrow) pays; contract splits worker cut / treasury margin
  rec.txs.pay = (await call(d.client, C, 'pay_job', { job_id: jobId }, { deposit: reward })).hash;
  const j = await view(C, 'get_job', { job_id: jobId });
  rec.workerCut = j.winning_price;
  log('client', `paid ${fmt(reward)} -> worker ${fmt(j.winning_price)}, treasury margin ${fmt(BigInt(reward) - BigInt(j.winning_price))}  ${txLink(rec.txs.pay)}`);

  // 7. Treasury settles the worker's USDC share on its own chain through NEAR Intents (dry quote, then on-chain gate)
  const usdShare = Number(((usd * Number(BigInt(j.winning_price) * 10000n / BigInt(reward))) / 10000).toFixed(2));
  try {
    const q = await dryQuote({ toChain: w.payoutChain, recipient: w.evm, usdcAmount: usdShare });
    const { result: decision, hash } = await call(d.coordinator, C, 'authorize_intent', {
      chain: w.payoutChain, recipient: w.evm, amount_usd_cents: String(Math.round(usdShare * 100)), quote_digest: q.digest,
    });
    run.intents.push({ jobId, worker: w.account, chain: w.payoutChain, recipient: w.evm, usd: usdShare, quoteOut: q.quote.amountOutFormatted, decision, tx: hash });
    log('treasury', `1Click dry quote: ${usdShare} USDC(NEAR) -> ${q.quote.amountOutFormatted} USDC on ${w.payoutChain} to ${w.evm.slice(0, 10)}... | contract says: ${decision}`);
  } catch (e) {
    log('treasury', `intent step skipped: ${e.message}`);
  }
  run.jobs.push(rec);
}

const s = await view(C, 'get_stats');
log('ok', `treasury ${fmt(s.treasury_balance)} | earned ${fmt(s.total_earned)} | swept to owner ${fmt(s.total_swept)} | audit events ${s.audit_len}`);
run.finished_at = new Date().toISOString();
run.stats = s;
fs.writeFileSync(path.join(OUT, 'last_swarm_run.json'), JSON.stringify(run, null, 2));
