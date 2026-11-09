// Scout agent: reads open jobs from NEAR Agent Market (market.near.ai) and ranks what the swarm can do.
// Live mode needs MARKET_API_KEY (an agent token from market.near.ai). Without it the bundled snapshot is used.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './near.js';

export const SKILLS = {
  research: ['research', 'economics', 'distribution', 'integrations', 'naming', 'brand', 'near', 'quotes', 'analysis', 'data'],
  code: ['javascript', 'typescript', 'ai', 'agents', 'automation', 'testing', 'python', 'mcp', 'rust'],
  writing: ['onboarding', 'content', 'docs', 'translation', 'research', 'report'],
};

export async function fetchJobs() {
  const key = process.env.MARKET_API_KEY;
  if (key) {
    try {
      const r = await fetch('https://market.near.ai/v1/jobs/board?limit=40&sort=recent', { headers: { authorization: `Bearer ${key}` } });
      if (r.ok) {
        const j = await r.json();
        const list = j.jobs || j.data || j.items || [];
        const jobs = list.filter((x) => ['open', 'filling', undefined].includes(x.status));
        if (jobs.length) return { source: 'live: market.near.ai/v1/jobs/board', jobs };
      }
    } catch { /* fall through to snapshot */ }
  }
  const snap = JSON.parse(fs.readFileSync(path.join(ROOT, 'agent', 'fixtures', 'market_jobs_snapshot.json'), 'utf8'));
  return { source: `snapshot: ${snap.source}`, jobs: snap.jobs };
}

export function fit(job) {
  const tags = (job.tags || []).map((t) => String(t).toLowerCase());
  const scores = Object.fromEntries(Object.entries(SKILLS).map(([role, kw]) => [role, tags.filter((t) => kw.includes(t)).length / Math.max(tags.length, 1)]));
  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  return { scores, bestRole: best[0], bestScore: best[1] };
}

export function rank(jobs, n = 3) {
  return jobs
    .map((j) => ({ job: j, fit: fit(j), usd: Number(j.budgetAmount || 0) }))
    .filter((x) => x.fit.bestScore >= 0.5 && x.usd >= 1)
    .sort((a, b) => b.fit.bestScore * Math.log10(1 + b.usd) - a.fit.bestScore * Math.log10(1 + a.usd))
    .slice(0, n);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { source, jobs } = await fetchJobs();
  console.log(`source: ${source} (${jobs.length} open jobs)`);
  for (const x of rank(jobs, 10)) console.log(`  ${x.fit.bestScore.toFixed(2)}  ${x.fit.bestRole.padEnd(8)} $${String(x.usd).padEnd(6)} ${x.job.title}`);
}
