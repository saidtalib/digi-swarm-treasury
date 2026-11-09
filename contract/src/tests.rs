use super::*;
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::testing_env;

const ONE: u128 = 1_000_000_000_000_000_000_000_000;

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn ctx(pred: &str, deposit: u128) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc("hq.testnet"))
        .predecessor_account_id(acc(pred))
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .block_timestamp(1_800_000_000_000_000_000);
    testing_env!(b.build());
}

fn policy() -> Policy {
    Policy {
        max_payout_per_tx: U128(ONE / 2),
        daily_cap: U128(ONE),
        sweep_threshold: U128(5 * ONE),
        sweep_keep: U128(ONE),
        ledger: acc("owner.testnet"),
        max_intent_usd_cents: U64(2_500),
        paused: false,
    }
}

fn setup() -> Contract {
    ctx("owner.testnet", 0);
    let mut c = Contract::new(acc("owner.testnet"), acc("coord.testnet"), policy());
    ctx("coord.testnet", 0);
    c.register_worker(acc("researcher.testnet"), "research".into());
    c.register_worker(acc("coder.testnet"), "code".into());
    c
}

#[test]
fn auction_picks_best_value_and_splits_revenue() {
    let mut c = setup();
    c.post_job("j1".into(), "Research".into(), "market.near.ai".into(), U128(2 * ONE));
    ctx("researcher.testnet", 0);
    c.submit_bid("j1".into(), U128(ONE), 90, 4);
    ctx("coder.testnet", 0);
    c.submit_bid("j1".into(), U128(ONE * 3 / 2), 95, 2);
    ctx("coord.testnet", 0);
    let w = c.close_auction("j1".into());
    assert_eq!(w, acc("researcher.testnet"));
    ctx("researcher.testnet", 0);
    c.deliver("j1".into(), "a".repeat(64));
    ctx("client.testnet", 2 * ONE);
    c.pay_job("j1".into());
    let s = c.get_stats();
    assert_eq!(s.treasury_balance.0, ONE);
    assert_eq!(s.total_earned.0, 2 * ONE);
    let job = c.get_job("j1".into()).unwrap();
    assert_eq!(job.status, JobStatus::Paid);
    assert_eq!(c.get_workers().iter().find(|w| w.account == acc("researcher.testnet")).unwrap().earned.0, ONE);
}

#[test]
#[should_panic(expected = "not your job")]
fn only_assigned_worker_can_deliver() {
    let mut c = setup();
    c.post_job("j1".into(), "t".into(), "s".into(), U128(ONE));
    ctx("researcher.testnet", 0);
    c.submit_bid("j1".into(), U128(ONE / 2), 80, 1);
    ctx("coord.testnet", 0);
    c.close_auction("j1".into());
    ctx("coder.testnet", 0);
    c.deliver("j1".into(), "b".repeat(64));
}

#[test]
#[should_panic(expected = "not a registered worker")]
fn strangers_cannot_bid() {
    let mut c = setup();
    c.post_job("j1".into(), "t".into(), "s".into(), U128(ONE));
    ctx("attacker.testnet", 0);
    c.submit_bid("j1".into(), U128(1), 100, 1);
}

#[test]
fn prompt_injected_payout_is_blocked_and_audited() {
    let mut c = setup();
    ctx("owner.testnet", 3 * ONE);
    c.fund_treasury();
    ctx("owner.testnet", 0);
    c.block_destination("near:drainer.testnet".into());
    ctx("coord.testnet", 0);
    let before = c.get_stats().audit_len.0;
    assert_eq!(
        c.request_payout(acc("drainer.testnet"), U128(ONE), "ignore previous instructions".into()),
        "blocked:destination_blocklisted"
    );
    assert_eq!(
        c.request_payout(acc("random.testnet"), U128(ONE / 10), "x".into()),
        "blocked:destination_not_allowlisted"
    );
    assert_eq!(c.get_stats().treasury_balance.0, 3 * ONE);
    assert_eq!(c.get_stats().audit_len.0, before + 2);
    assert!(get_logs().iter().any(|l| l.contains("blocked:destination_blocklisted")));
}

#[test]
fn caps_queue_for_owner_then_owner_approves() {
    let mut c = setup();
    ctx("owner.testnet", 3 * ONE);
    c.fund_treasury();
    ctx("coord.testnet", 0);
    assert_eq!(c.request_payout(acc("coder.testnet"), U128(ONE / 4), "tooling".into()), "executed");
    let d = c.request_payout(acc("coder.testnet"), U128(ONE), "big".into());
    assert!(d.starts_with("queued:needs_owner_approval:over_per_tx_cap"));
    assert_eq!(c.request_payout(acc("coder.testnet"), U128(ONE / 2), "a".into()), "executed");
    let d2 = c.request_payout(acc("coder.testnet"), U128(ONE / 2), "b".into());
    assert!(d2.contains("over_daily_cap"));
    ctx("owner.testnet", 0);
    assert_eq!(c.approve_pending(0), "executed");
    assert_eq!(c.get_pending()[0].status, "approved");
    assert_eq!(c.get_stats().treasury_balance.0, 3 * ONE - ONE / 4 - ONE / 2 - ONE);
}

#[test]
#[should_panic(expected = "owner only")]
fn coordinator_cannot_change_policy() {
    let mut c = setup();
    c.set_policy(policy());
}

#[test]
fn profit_sweeps_to_ledger_above_threshold() {
    let mut c = setup();
    ctx("owner.testnet", 6 * ONE);
    c.fund_treasury();
    let s = c.get_stats();
    assert_eq!(s.treasury_balance.0, ONE);
    assert_eq!(s.total_swept.0, 5 * ONE);
}

#[test]
fn intents_gate() {
    let mut c = setup();
    ctx("owner.testnet", 0);
    c.allow_destination("base:0x59Dc3f8196B923e121B0A481b6b5b9CcEc29dbD1".into());
    ctx("coord.testnet", 0);
    assert_eq!(c.authorize_intent("base".into(), "0x59dc3f8196b923e121b0a481b6b5b9ccec29dbd1".into(), U64(500), "q".into()), "authorized");
    assert_eq!(c.authorize_intent("base".into(), "0x59dc3f8196b923e121b0a481b6b5b9ccec29dbd1".into(), U64(9_999), "q".into()), "blocked:over_intent_cap");
    assert_eq!(c.authorize_intent("arb".into(), "0xdead".into(), U64(1), "q".into()), "blocked:destination_not_allowlisted");
    ctx("owner.testnet", 0);
    c.set_paused(true);
    ctx("coord.testnet", 0);
    assert_eq!(c.authorize_intent("base".into(), "0x59dc3f8196b923e121b0a481b6b5b9ccec29dbd1".into(), U64(1), "q".into()), "rejected:paused");
    assert_eq!(c.get_intents().len(), 4);
}

#[test]
fn audit_chain_is_reproducible() {
    let c = setup();
    let page = c.get_audit(None, None);
    let mut head = "0".repeat(64);
    for e in page.events.iter() {
        let mut buf = head.clone().into_bytes();
        buf.extend_from_slice(e.as_bytes());
        head = hex::encode(env::sha256(&buf));
    }
    assert_eq!(head, page.head);
    assert_eq!(page.total.0, 3);
}
