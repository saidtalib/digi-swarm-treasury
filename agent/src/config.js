// Demo constants. All amounts are testnet NEAR. Change them here, not in the contract.
import { nearToYocto } from './near.js';

export const Y = (near) => nearToYocto(String(near)).toString();

export const POLICY = {
  max_payout_per_tx: Y(0.05),   // agents may pay at most 0.05 NEAR per payout without the owner
  daily_cap: Y(0.12),           // and at most 0.12 NEAR per UTC day
  sweep_threshold: Y(0.7),      // treasury above 0.7 NEAR ...
  sweep_keep: Y(0.5),           // ... sweeps everything above 0.5 NEAR to the owner's ledger account
  max_intent_usd_cents: '10000',// cross-chain USDC payouts through NEAR Intents: max $100 each
  paused: false,
};

export const REWARD_NEAR_PER_USD = Number(process.env.REWARD_NEAR_PER_USD || 0.002); // $100 job -> 0.2 testnet NEAR
export const MAX_JOB_REWARD_NEAR = 0.3;

export const WORKERS = [
  { prefix: 'researcher', role: 'research', payoutChain: 'base' },
  { prefix: 'coder', role: 'code', payoutChain: 'arb' },
  { prefix: 'writer', role: 'writing', payoutChain: 'base' },
];

export const COORD_METHODS = ['register_worker', 'post_job', 'close_auction', 'request_payout', 'authorize_intent'];
export const WORKER_METHODS = ['submit_bid', 'deliver'];
export const KNOWN_SCAM = 'drainer-demo.testnet';
