//! Digi Swarm Treasury
//!
//! A NEAR contract that lets a human owner set hard constraints for an
//! autonomous agent swarm, and then lets the agents run the business inside
//! those constraints:
//!
//! * worker agents (NEAR sub-accounts) bid on jobs; the contract picks the
//!   winner deterministically (price x confidence x reputation),
//! * client payments are split on-chain: the winning worker gets its bid,
//!   the treasury keeps the margin,
//! * every outgoing payout and every cross-chain NEAR Intents payout is
//!   checked against the owner's policy (per-tx cap, daily cap, allowlist,
//!   blocklist, pause). Anything over the caps is queued for the owner,
//! * profit above a threshold is swept automatically to the owner's cold
//!   account ("bank it" rule),
//! * every decision (including blocked ones) is appended to a sha256
//!   hash-chained audit log that anyone can re-verify from view calls.
//!
//! The agents only hold function-call access keys limited to this contract,
//! so even a fully prompt-injected agent cannot move NEAR directly.

use near_sdk::json_types::{U128, U64};
use near_sdk::store::{IterableMap, IterableSet, Vector};
use near_sdk::{env, near, require, AccountId, BorshStorageKey, NearToken, PanicOnDefault, Promise};

const NS_PER_DAY: u64 = 86_400_000_000_000;
const MAX_BIDS_PER_JOB: usize = 16;
const MAX_TEXT: usize = 280;

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Workers,
    Jobs,
    Allow,
    Block,
    Pending,
    Intents,
    Audit,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Policy {
    /// Largest native NEAR payout the agents may execute without the owner (yocto).
    pub max_payout_per_tx: U128,
    /// Total native NEAR the agents may pay out per UTC day without the owner (yocto).
    pub daily_cap: U128,
    /// When the treasury balance is above this, the excess over `sweep_keep` goes to `ledger` (yocto).
    pub sweep_threshold: U128,
    /// Amount the treasury keeps after a sweep (yocto).
    pub sweep_keep: U128,
    /// Owner's cold account that receives sweeps.
    pub ledger: AccountId,
    /// Largest cross-chain (NEAR Intents) payout the agents may authorise, in USD cents.
    pub max_intent_usd_cents: U64,
    /// Emergency stop: no payouts, no intents.
    pub paused: bool,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Worker {
    pub account: AccountId,
    pub role: String,
    pub reputation: u32,
    pub jobs_done: u32,
    pub earned: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Bid {
    pub worker: AccountId,
    pub price: U128,
    pub confidence_pct: u8,
    pub eta_hours: u32,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum JobStatus {
    Open,
    Assigned,
    Delivered,
    Paid,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Job {
    pub id: String,
    pub title: String,
    pub source: String,
    pub reward: U128,
    pub status: JobStatus,
    pub bids: Vec<Bid>,
    pub assigned_to: Option<AccountId>,
    pub winning_price: Option<U128>,
    pub deliverable_sha256: Option<String>,
    pub paid_amount: Option<U128>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct PendingPayout {
    pub id: u64,
    pub to: AccountId,
    pub amount: U128,
    pub memo: String,
    pub reason: String,
    pub status: String,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct IntentAuth {
    pub id: u64,
    pub chain: String,
    pub recipient: String,
    pub amount_usd_cents: U64,
    pub quote_digest: String,
    pub status: String,
    pub block_height: U64,
}

#[near(serializers = [json])]
pub struct AuditPage {
    pub head: String,
    pub total: U64,
    pub events: Vec<String>,
}

#[near(serializers = [json])]
pub struct Stats {
    pub owner: AccountId,
    pub coordinator: AccountId,
    pub treasury_balance: U128,
    pub total_earned: U128,
    pub total_paid_out: U128,
    pub total_swept: U128,
    pub spent_today: U128,
    pub workers: u32,
    pub jobs: u32,
    pub audit_len: U64,
    pub audit_head: String,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner: AccountId,
    coordinator: AccountId,
    policy: Policy,
    workers: IterableMap<AccountId, Worker>,
    jobs: IterableMap<String, Job>,
    allowlist: IterableSet<String>,
    blocklist: IterableSet<String>,
    pending: Vector<PendingPayout>,
    intents: Vector<IntentAuth>,
    audit: Vector<String>,
    audit_head: String,
    treasury_balance: u128,
    total_earned: u128,
    total_paid_out: u128,
    total_swept: u128,
    spent_day: u64,
    spent_today: u128,
}

fn short(s: &str) -> String {
    s.chars().take(MAX_TEXT).collect()
}

fn esc(s: &str) -> String {
    // Minimal JSON string escaping for event payloads.
    let mut o = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            '\n' => o.push_str("\\n"),
            '\r' => o.push_str("\\r"),
            '\t' => o.push_str("\\t"),
            c if (c as u32) < 0x20 => o.push(' '),
            c => o.push(c),
        }
    }
    o
}

#[near]
impl Contract {
    #[init]
    pub fn new(owner: AccountId, coordinator: AccountId, policy: Policy) -> Self {
        let mut c = Self {
            owner,
            coordinator,
            policy,
            workers: IterableMap::new(StorageKey::Workers),
            jobs: IterableMap::new(StorageKey::Jobs),
            allowlist: IterableSet::new(StorageKey::Allow),
            blocklist: IterableSet::new(StorageKey::Block),
            pending: Vector::new(StorageKey::Pending),
            intents: Vector::new(StorageKey::Intents),
            audit: Vector::new(StorageKey::Audit),
            audit_head: "0".repeat(64),
            treasury_balance: 0,
            total_earned: 0,
            total_paid_out: 0,
            total_swept: 0,
            spent_day: 0,
            spent_today: 0,
        };
        let data = format!(
            "{{\"owner\":\"{}\",\"coordinator\":\"{}\",\"ledger\":\"{}\"}}",
            c.owner, c.coordinator, c.policy.ledger
        );
        c.emit("init", &data);
        c
    }

    // ------------------------------------------------------------------
    // Owner: the human sets the constraints
    // ------------------------------------------------------------------

    pub fn set_policy(&mut self, policy: Policy) {
        self.assert_owner();
        self.policy = policy;
        let data = format!(
            "{{\"max_payout_per_tx\":\"{}\",\"daily_cap\":\"{}\",\"paused\":{}}}",
            self.policy.max_payout_per_tx.0, self.policy.daily_cap.0, self.policy.paused
        );
        self.emit("policy_set", &data);
    }

    pub fn set_paused(&mut self, paused: bool) {
        self.assert_owner();
        self.policy.paused = paused;
        self.emit("paused", &format!("{{\"paused\":{}}}", paused));
    }

    /// Destinations are `near:<account>` or `<chain>:<address>` for intents, e.g. `base:0xabc...`.
    pub fn allow_destination(&mut self, dest: String) {
        self.assert_owner();
        let d = dest.to_lowercase();
        self.allowlist.insert(d.clone());
        self.emit("allow", &format!("{{\"dest\":\"{}\"}}", esc(&d)));
    }

    pub fn remove_destination(&mut self, dest: String) {
        self.assert_owner();
        let d = dest.to_lowercase();
        self.allowlist.remove(&d);
        self.emit("unallow", &format!("{{\"dest\":\"{}\"}}", esc(&d)));
    }

    pub fn block_destination(&mut self, dest: String) {
        self.assert_owner();
        let d = dest.to_lowercase();
        self.blocklist.insert(d.clone());
        self.emit("block", &format!("{{\"dest\":\"{}\"}}", esc(&d)));
    }

    pub fn set_coordinator(&mut self, coordinator: AccountId) {
        self.assert_owner();
        self.coordinator = coordinator;
        self.emit("coordinator_set", &format!("{{\"coordinator\":\"{}\"}}", self.coordinator));
    }

    pub fn approve_pending(&mut self, id: u64) -> String {
        self.assert_owner();
        let mut p = self.pending.get(id as u32).cloned().expect("no such pending payout");
        require!(p.status == "queued", "pending payout is not queued");
        require!(p.amount.0 <= self.treasury_balance, "treasury balance too low");
        p.status = "approved".to_string();
        self.pending.replace(id as u32, p.clone());
        self.pay(&p.to, p.amount.0);
        self.emit(
            "payout_approved",
            &format!("{{\"id\":{},\"to\":\"{}\",\"amount\":\"{}\"}}", id, p.to, p.amount.0),
        );
        "executed".to_string()
    }

    pub fn reject_pending(&mut self, id: u64) {
        self.assert_owner();
        let mut p = self.pending.get(id as u32).cloned().expect("no such pending payout");
        require!(p.status == "queued", "pending payout is not queued");
        p.status = "rejected".to_string();
        self.pending.replace(id as u32, p);
        self.emit("payout_rejected", &format!("{{\"id\":{}}}", id));
    }

    // ------------------------------------------------------------------
    // Money in
    // ------------------------------------------------------------------

    /// Anyone can top up the treasury.
    #[payable]
    pub fn fund_treasury(&mut self) {
        let amount = env::attached_deposit().as_yoctonear();
        require!(amount > 0, "attach NEAR");
        self.treasury_balance += amount;
        self.emit(
            "treasury_funded",
            &format!("{{\"from\":\"{}\",\"amount\":\"{}\"}}", env::predecessor_account_id(), amount),
        );
        self.maybe_sweep();
    }

    /// The client (or a marketplace escrow) pays for a delivered job.
    /// The winning worker gets its bid price, the treasury keeps the margin.
    #[payable]
    pub fn pay_job(&mut self, job_id: String) {
        let amount = env::attached_deposit().as_yoctonear();
        require!(amount > 0, "attach NEAR");
        let mut job = self.jobs.get(&job_id).cloned().expect("unknown job");
        require!(job.status == JobStatus::Delivered, "job is not delivered");
        let worker_id = job.assigned_to.clone().unwrap();
        let worker_cut = job.winning_price.unwrap().0.min(amount);
        let margin = amount - worker_cut;

        job.status = JobStatus::Paid;
        job.paid_amount = Some(U128(amount));
        self.jobs.insert(job_id.clone(), job);

        if let Some(w) = self.workers.get_mut(&worker_id) {
            w.jobs_done += 1;
            w.reputation = w.reputation.saturating_add(10);
            w.earned = U128(w.earned.0 + worker_cut);
        }
        self.total_earned += amount;
        self.treasury_balance += margin;
        if worker_cut > 0 {
            let _ = Promise::new(worker_id.clone()).transfer(NearToken::from_yoctonear(worker_cut));
        }
        self.emit(
            "job_paid",
            &format!(
                "{{\"job\":\"{}\",\"payer\":\"{}\",\"amount\":\"{}\",\"worker\":\"{}\",\"worker_cut\":\"{}\",\"treasury_margin\":\"{}\"}}",
                esc(&job_id),
                env::predecessor_account_id(),
                amount,
                worker_id,
                worker_cut,
                margin
            ),
        );
        self.maybe_sweep();
    }

    // ------------------------------------------------------------------
    // Coordinator agent: runs the business inside the constraints
    // ------------------------------------------------------------------

    pub fn register_worker(&mut self, account: AccountId, role: String) {
        self.assert_coordinator();
        require!(self.workers.len() < 32, "too many workers");
        let w = Worker { account: account.clone(), role: short(&role), reputation: 0, jobs_done: 0, earned: U128(0) };
        self.workers.insert(account.clone(), w);
        self.emit("worker_registered", &format!("{{\"worker\":\"{}\",\"role\":\"{}\"}}", account, esc(&short(&role))));
    }

    pub fn post_job(&mut self, job_id: String, title: String, source: String, reward: U128) {
        self.assert_coordinator();
        require!(job_id.len() <= 64 && !job_id.is_empty(), "bad job id");
        require!(self.jobs.get(&job_id).is_none(), "job exists");
        let job = Job {
            id: job_id.clone(),
            title: short(&title),
            source: short(&source),
            reward,
            status: JobStatus::Open,
            bids: vec![],
            assigned_to: None,
            winning_price: None,
            deliverable_sha256: None,
            paid_amount: None,
        };
        self.jobs.insert(job_id.clone(), job);
        self.emit(
            "job_posted",
            &format!("{{\"job\":\"{}\",\"source\":\"{}\",\"reward\":\"{}\"}}", esc(&job_id), esc(&short(&source)), reward.0),
        );
    }

    /// Called by a worker agent (its own sub-account) to bid for a job.
    pub fn submit_bid(&mut self, job_id: String, price: U128, confidence_pct: u8, eta_hours: u32) {
        let worker = env::predecessor_account_id();
        require!(self.workers.get(&worker).is_some(), "not a registered worker");
        require!(confidence_pct > 0 && confidence_pct <= 100, "confidence 1..100");
        let mut job = self.jobs.get(&job_id).cloned().expect("unknown job");
        require!(job.status == JobStatus::Open, "auction closed");
        require!(price.0 <= job.reward.0, "bid above job reward");
        require!(job.bids.len() < MAX_BIDS_PER_JOB, "too many bids");
        job.bids.retain(|b| b.worker != worker);
        job.bids.push(Bid { worker: worker.clone(), price, confidence_pct, eta_hours });
        self.jobs.insert(job_id.clone(), job);
        self.emit(
            "bid",
            &format!(
                "{{\"job\":\"{}\",\"worker\":\"{}\",\"price\":\"{}\",\"confidence\":{},\"eta_hours\":{}}}",
                esc(&job_id), worker, price.0, confidence_pct, eta_hours
            ),
        );
    }

    /// Picks the bid with the best value: confidence x (100 + reputation) / price.
    pub fn close_auction(&mut self, job_id: String) -> AccountId {
        self.assert_coordinator();
        let mut job = self.jobs.get(&job_id).cloned().expect("unknown job");
        require!(job.status == JobStatus::Open, "auction closed");
        require!(!job.bids.is_empty(), "no bids");
        let mut best: Option<(u128, Bid)> = None;
        for b in job.bids.iter() {
            let rep = self.workers.get(&b.worker).map(|w| w.reputation.min(100)).unwrap_or(0) as u128;
            let score = (b.confidence_pct as u128) * (100 + rep) * 1_000_000_000_000_000_000_000_000u128 / b.price.0.max(1);
            if best.as_ref().map(|(s, _)| score > *s).unwrap_or(true) {
                best = Some((score, b.clone()));
            }
        }
        let (_, win) = best.unwrap();
        job.status = JobStatus::Assigned;
        job.assigned_to = Some(win.worker.clone());
        job.winning_price = Some(win.price);
        self.jobs.insert(job_id.clone(), job);
        self.emit(
            "job_assigned",
            &format!("{{\"job\":\"{}\",\"worker\":\"{}\",\"price\":\"{}\"}}", esc(&job_id), win.worker, win.price.0),
        );
        win.worker
    }

    /// Called by the assigned worker with the sha256 of its deliverable.
    pub fn deliver(&mut self, job_id: String, deliverable_sha256: String) {
        let worker = env::predecessor_account_id();
        let mut job = self.jobs.get(&job_id).cloned().expect("unknown job");
        require!(job.status == JobStatus::Assigned, "job is not assigned");
        require!(job.assigned_to.as_ref() == Some(&worker), "not your job");
        require!(deliverable_sha256.len() == 64 && hex::decode(&deliverable_sha256).is_ok(), "sha256 hex expected");
        job.status = JobStatus::Delivered;
        job.deliverable_sha256 = Some(deliverable_sha256.clone());
        self.jobs.insert(job_id.clone(), job);
        self.emit(
            "delivered",
            &format!("{{\"job\":\"{}\",\"worker\":\"{}\",\"sha256\":\"{}\"}}", esc(&job_id), worker, esc(&deliverable_sha256)),
        );
    }

    /// The coordinator asks to pay native NEAR out of the treasury.
    /// Never panics on a policy violation: the decision is recorded in the audit log and returned.
    pub fn request_payout(&mut self, to: AccountId, amount: U128, memo: String) -> String {
        self.assert_coordinator();
        let dest = format!("near:{}", to).to_lowercase();
        let decision = if self.policy.paused {
            "rejected:paused".to_string()
        } else if self.blocklist.contains(&dest) {
            "blocked:destination_blocklisted".to_string()
        } else if !(self.allowlist.contains(&dest) || self.workers.get(&to).is_some() || to == self.policy.ledger) {
            "blocked:destination_not_allowlisted".to_string()
        } else if amount.0 == 0 || amount.0 > self.treasury_balance {
            "rejected:insufficient_treasury".to_string()
        } else {
            self.roll_day();
            if amount.0 > self.policy.max_payout_per_tx.0 || self.spent_today + amount.0 > self.policy.daily_cap.0 {
                let id = self.pending.len() as u64;
                let reason = if amount.0 > self.policy.max_payout_per_tx.0 { "over_per_tx_cap" } else { "over_daily_cap" };
                self.pending.push(PendingPayout {
                    id,
                    to: to.clone(),
                    amount,
                    memo: short(&memo),
                    reason: reason.to_string(),
                    status: "queued".to_string(),
                });
                format!("queued:needs_owner_approval:{}#{}", reason, id)
            } else {
                self.spent_today += amount.0;
                self.pay(&to, amount.0);
                "executed".to_string()
            }
        };
        self.emit(
            "payout_request",
            &format!(
                "{{\"to\":\"{}\",\"amount\":\"{}\",\"memo\":\"{}\",\"decision\":\"{}\"}}",
                to, amount.0, esc(&short(&memo)), decision
            ),
        );
        decision
    }

    /// The coordinator asks for permission to execute a cross-chain payout through NEAR Intents.
    /// `quote_digest` is the sha256 of the 1Click quote the agent intends to execute.
    /// The contract does not move funds here; it is the on-chain gate the agent must pass first.
    pub fn authorize_intent(&mut self, chain: String, recipient: String, amount_usd_cents: U64, quote_digest: String) -> String {
        self.assert_coordinator();
        let dest = format!("{}:{}", chain, recipient).to_lowercase();
        let status = if self.policy.paused {
            "rejected:paused".to_string()
        } else if self.blocklist.contains(&dest) {
            "blocked:destination_blocklisted".to_string()
        } else if !self.allowlist.contains(&dest) {
            "blocked:destination_not_allowlisted".to_string()
        } else if amount_usd_cents.0 > self.policy.max_intent_usd_cents.0 {
            "blocked:over_intent_cap".to_string()
        } else {
            "authorized".to_string()
        };
        let id = self.intents.len() as u64;
        self.intents.push(IntentAuth {
            id,
            chain: short(&chain),
            recipient: short(&recipient),
            amount_usd_cents,
            quote_digest: short(&quote_digest),
            status: status.clone(),
            block_height: U64(env::block_height()),
        });
        self.emit(
            "intent_request",
            &format!(
                "{{\"id\":{},\"dest\":\"{}\",\"usd_cents\":{},\"quote_digest\":\"{}\",\"decision\":\"{}\"}}",
                id, esc(&dest), amount_usd_cents.0, esc(&short(&quote_digest)), status
            ),
        );
        status
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    pub fn get_policy(&self) -> Policy {
        self.policy.clone()
    }

    pub fn get_stats(&self) -> Stats {
        let today = env::block_timestamp() / NS_PER_DAY;
        Stats {
            owner: self.owner.clone(),
            coordinator: self.coordinator.clone(),
            treasury_balance: U128(self.treasury_balance),
            total_earned: U128(self.total_earned),
            total_paid_out: U128(self.total_paid_out),
            total_swept: U128(self.total_swept),
            spent_today: U128(if self.spent_day == today { self.spent_today } else { 0 }),
            workers: self.workers.len(),
            jobs: self.jobs.len(),
            audit_len: U64(self.audit.len() as u64),
            audit_head: self.audit_head.clone(),
        }
    }

    pub fn get_workers(&self) -> Vec<Worker> {
        self.workers.values().cloned().collect()
    }

    pub fn get_jobs(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<Job> {
        self.jobs
            .values()
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(50) as usize)
            .cloned()
            .collect()
    }

    pub fn get_job(&self, job_id: String) -> Option<Job> {
        self.jobs.get(&job_id).cloned()
    }

    pub fn get_pending(&self) -> Vec<PendingPayout> {
        self.pending.iter().cloned().collect()
    }

    pub fn get_intents(&self) -> Vec<IntentAuth> {
        self.intents.iter().cloned().collect()
    }

    pub fn get_allowlist(&self) -> Vec<String> {
        self.allowlist.iter().cloned().collect()
    }

    pub fn get_blocklist(&self) -> Vec<String> {
        self.blocklist.iter().cloned().collect()
    }

    /// Returns audit events; head = sha256(prev_head_hex || event_json) chained from 64 zeros.
    pub fn get_audit(&self, from_index: Option<u32>, limit: Option<u32>) -> AuditPage {
        let from = from_index.unwrap_or(0);
        let lim = limit.unwrap_or(100).min(200);
        let events = (from..(from + lim).min(self.audit.len())).map(|i| self.audit[i].clone()).collect();
        AuditPage { head: self.audit_head.clone(), total: U64(self.audit.len() as u64), events }
    }

    // ------------------------------------------------------------------
    // Internal
    // ------------------------------------------------------------------

    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
    }

    fn assert_coordinator(&self) {
        let p = env::predecessor_account_id();
        require!(p == self.coordinator || p == self.owner, "coordinator only");
    }

    fn roll_day(&mut self) {
        let today = env::block_timestamp() / NS_PER_DAY;
        if today != self.spent_day {
            self.spent_day = today;
            self.spent_today = 0;
        }
    }

    fn pay(&mut self, to: &AccountId, amount: u128) {
        require!(amount <= self.treasury_balance, "treasury balance too low");
        self.treasury_balance -= amount;
        self.total_paid_out += amount;
        let _ = Promise::new(to.clone()).transfer(NearToken::from_yoctonear(amount));
    }

    fn maybe_sweep(&mut self) {
        if self.treasury_balance > self.policy.sweep_threshold.0 && self.treasury_balance > self.policy.sweep_keep.0 {
            let amount = self.treasury_balance - self.policy.sweep_keep.0;
            self.treasury_balance -= amount;
            self.total_swept += amount;
            let ledger = self.policy.ledger.clone();
            let _ = Promise::new(ledger.clone()).transfer(NearToken::from_yoctonear(amount));
            self.emit("sweep", &format!("{{\"to\":\"{}\",\"amount\":\"{}\"}}", ledger, amount));
        }
    }

    fn emit(&mut self, event: &str, data: &str) {
        let json = format!(
            "{{\"standard\":\"digi_swarm\",\"version\":\"1.0.0\",\"event\":\"{}\",\"data\":[{}],\"block\":{},\"seq\":{}}}",
            event,
            data,
            env::block_height(),
            self.audit.len()
        );
        let mut buf = self.audit_head.clone().into_bytes();
        buf.extend_from_slice(json.as_bytes());
        self.audit_head = hex::encode(env::sha256(&buf));
        env::log_str(&format!("EVENT_JSON:{}", json));
        self.audit.push(json);
    }
}

#[cfg(test)]
mod tests;
