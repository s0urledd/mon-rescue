# Winning the unbonding race: which method is fastest, and how to run backups

The question is not "which RPC is fastest". It is **which method puts our transaction in front
of the attacker's at the one block that matters**, and **what happens when the primary method
fails**. This document ranks the methods and specifies the redundancy layout.

Everything here is about **unbonding MON**, the defensible case. Liquid MON against an alert
seed holder is not defensible and we do not claim it is.

---

## What we are actually racing

Measured on testnet, two independent archive nodes agreeing:

- The boundary block is exactly `(epoch - 1) × 50,000`. Deterministic.
- The epoch then begins **4,962–4,999 blocks later**, bounded above by `EPOCH_DELAY_ROUNDS`
  (5,000) because rounds advance at least as fast as blocks.

So the unlock moment is known to within about **40 blocks ≈ 12 seconds** at the measured
~0.301 s/block. That residual uncertainty is the entire battlefield.

The attacker's simplest path needs no EIP-7702 at all: two ordinary transactions,
`withdraw()` then a plain transfer. Our edge is that ours is **one atomic transaction** that
does both — but only if it executes first.

---

## The methods, ranked — revised after measurement

The original ranking put "pre-submitted spray" first on the grounds that detection latency was
unavoidable. Measurement changed the picture.

### 1. React from a local node, and pre-queue across the flip window

Detection beside a local node is **~8ms** — under 4% of a block — against ~116ms over remote
RPC. The spray was designed for the 116ms world; in the 8ms world its only remaining value is
narrow and specific:

**The epoch advances in transaction 0 of the flip block.** So a transaction already sitting in a
leader's mempool is included in *that same block*, after the syscall, and succeeds. Reacting —
however fast — reaches only block **N+1**.

That one block decides the race in exactly one of three cases:

| attacker | us | outcome |
|---|---|---|
| reacts | reacts | both at N+1 — fee decides |
| reacts | pre-queued | we are in N, they are in N+1 — **we win outright** |
| pre-queues | pre-queues | both in N — fee decides |

Pre-queuing costs ~2 MON in premature reverts (each is charged its full gas limit). **Do it
anyway.** The loss is asymmetric: it can only ever win a block, while skipping it can lose the
entire position, and we cannot know in advance whether a rescue is contested. `SPRAY_MODE=off`
applies only when the position is already mature and there is no flip to arrive ahead of.

### 2. Everything expensive happens before the window

Positions discovered, reserve floor computed, gas sized, fees planned, and **every attempt
signed** — all while idle. Measured: 31 attempts pre-signed in 118ms. The flip window does
nothing but broadcast.

### 3. Local node for both reads and broadcast

Submission used to go to remote endpoints only, measured at 69–261ms, while a node answering in
single-digit milliseconds sat on the same host — and that node is the one that forwards to
upcoming leaders. Local first, remotes behind as failover.

Remote failover is worth keeping for a reason the first analysis got wrong: the retry cycle
belongs to the **owner node**, so each endpoint submitted to runs its own `K=3` cycle of
re-forwarding. Across the retry window that is genuinely broader coverage, not merely insurance.

---

## Redundancy: three independent firers

This is why `rescue()` and `sweep()` are **permissionless**.

Access control on a destination-locked function buys nothing — funds can only ever reach
`SAFE_ADDRESS`, so the worst any caller can do is pay gas to move the user's money to the
user's own safe address. What access control *would* cost is the failure mode that actually
loses funds: our process being down at the unlock block.

Recommended layout, in different failure domains:

| # | Where | Method | Fails when |
|---|---|---|---|
| **A** | beside the operator's own Monad node | spray + event-driven backstop | that machine or node is down |
| **B** | separate cloud host, different provider | spray via remote RPC | that host is down |
| **C** | the user's own machine | detector + single fire | the user's machine is off |

All three fire the same rescue against the same contract. Each uses its **own sender address
and nonce sequence**, so they do not conflict — the first to land succeeds, the rest revert
cheaply with `NothingToSweep`. Losing agents pay gas; that is the entire cost of redundancy.

Because any of them (or a stranger) may be the one that wins, "did it work" is answered by
watching the **safe address balance**, not by waiting on our own receipt.
`makeSafeBalanceChecker()` does this.

---

## Fee strategy — a budget, not a multiplier

Leaders order by descending total gas price, so the race is an auction with no private mempool
to route around it.

`PRIORITY_FEE_MULTIPLIER` was meaningless: it scaled `estimateFeesPerGas`, and Monad's
`eth_maxPriorityFeePerGas` returns a **hardcoded 2 gwei**. "20x" multiplied a constant that
carries no information about competition.

Measured on mainnet across 69 transactions: base pinned at the **100 gwei floor**, median tip
**2 gwei**, p90 78, **highest observed 1,482**. Beating the median is free; beating the top
bidder is not, and an attacker racing us is a top bidder by construction. That 700x spread is
the question in one number.

So fees are **MON per attempt**. `observeFees()` samples live bids, `feeSchedule()` climbs from
2x the p90 toward the authorised budget on a **cubic** curve, and every rung is pre-signed.
With a 20 MON budget on mainnet: attempt 1 costs 0.047 MON, attempt 4 costs 0.45, and 20 MON is
reached only at attempt 12. The first three together cost 0.28 MON.

Cubic rather than linear because most rescues are uncontested — a linear ramp reached half the
budget by mid-sequence and spent heavily on fights that were not happening. The spray checks
whether the rescue landed before each attempt, so an early cheap success stops the ladder before
the expensive rungs are ever broadcast.

Consecutive nonces, not a shared one: same-nonce replacement is undocumented on Monad, so
relying on it to supersede a cheaper attempt would build on an assumption.

There is precedent that outbidding works: **Harpie** beat drainer bots on Ethereum at a claimed
~99.8% success rate using nothing but gas outbidding in the public mempool.

---

## Layered defence, in firing order

1. **At intake** — the user authorises delegation to their own rescue contract and signs an
   authorization window. Usually this happens *after* the compromise, not before: nobody
   registers ahead of time, and the unbonding delay is what makes late arrival survivable.
2. **On compromise signal** — `guard.ts` watches for a delegation change, a nonce advance, or
   an unexpected unstake. A delegation change is the loudest signal available: only one 7702
   delegation is active at a time, so a sophisticated attacker must re-delegate before they can
   steal atomically, which announces the attack.
3. **Through the window** — attempts stay queued so one is present when the flip block is
   built, which is the only way to land in that block rather than the one after it.
4. **At the flip** — the ladder escalates if nothing has landed.
5. **After a loss** — this is not over. If the attacker's `withdraw()` landed first, the funds
   are sitting on an EOA still delegated to a destination-locked contract, and `sweep()` takes
   them. `rescue()` deliberately does not abort when withdrawals fail, precisely because the
   likeliest reason for that failure is that the money has already arrived.

---

## What still beats us

Stated plainly, because a rescue tool that oversells itself is worse than none:

- An attacker who **exhausts the authorization window** (16+ transactions from the account)
  removes our ability to re-assert the delegation. `assessWindow()` warns before this, but the
  fix — the user re-signing — requires them to still control the account.
- An attacker who **wins the auction** at the flip block. We can bid, but so can they.
- Anything involving **liquid MON**, which is not defensible against a live seed holder.

The honest claim is bounded: MonRescue materially improves the odds for unbonding MON against
an unattended or unsophisticated drainer, and offers no cryptographic guarantee against an
alert one. The only design that defeats a live seed holder is a smart account with a withdrawal
timelock and a guardian veto — a migration, not a retrofit.

---

## Operating this as a service — the one constraint that bites

If we rescue several customers, the binding limit is not RPC capacity or CPU. It is that
**Monad's inflight gas cap is per account**: the sum of `gas_price × gas_limit` across an
account's transactions from the last 3 blocks must stay under `min(10 MON, lagged balance)`.

That cap belongs to the *guardian address*, not to the customer. So a single guardian key
spraying for two customers whose positions mature in the same epoch splits one budget between
them — and epochs are shared, so simultaneous maturity is the normal case, not an edge one.

At 350k gas and a 20x fee multiplier the budget affords a few dozen inflight attempts. One
customer can consume all of it.

**Therefore: one guardian key per concurrently-armed customer.** Guardians are cheap — a
keypair and >10 MON — and they choose nothing, since the destination is immutable in each
customer's own contract. A stolen guardian key cannot redirect funds; it can only pay gas to
move a customer's money to that customer's own safe address. So a pool of them carries no extra
custody risk, which is exactly what makes this the easy fix rather than a hard one.

The current CLI is one process per customer, which already implies this. It is worth stating
because the failure mode is silent: a shared guardian does not error, it just has its retries
throttled at the unlock block, which is indistinguishable from ordinary bad luck.

**Not yet decided:** whether a success fee is taken on-chain. It cannot come out of the rescue
contract without weakening the destination lock, which is the property the whole design rests
on. Bill out of band.
