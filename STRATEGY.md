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

## The methods, ranked

### 1. Pre-submitted spray — fastest possible, and the primary

**Do not detect anything.** Pre-sign a sequence of identical rescue transactions at
consecutive nonces and keep one in flight throughout the ~100-block uncertainty window, so a
transaction is **already queued at the leader when the epoch flips**.

Reaction time is zero, because there is no reaction. Every other method pays detection latency;
this one structurally cannot.

*Why it is safe.* An attempt that executes before maturity reverts — `withdraw()` fails,
nothing is credited, `_sweep` reverts with `NothingToSweep`. A revert rolls back all state, so
**the withdrawal request is left completely intact** for the next attempt. The only cost of a
premature attempt is gas.

*Why it works on Monad specifically.* Proposers cannot see current state, so transactions that
will revert are still included and still charged. On a chain that dropped such transactions
pre-submission would be pointless.

*Cost.* Gas on every attempt that lands early — roughly 30-40 attempts at one per three blocks.
The rescued position is worth orders of magnitude more.

*Constraint.* Monad caps an account's total gas across inflight transactions (last 3 blocks) at
`min(10 MON, lagged balance)`. An unbounded spray throttles itself at exactly the wrong moment,
so `maxInFlight` is enforced and the guardian must hold well over 10 MON.

Implemented in `rescue-cli/src/strategies.ts`.

### 2. Event-driven on a local node

Monad exposes execution events from the node itself rather than over JSON-RPC. Running the
daemon beside a node turns detection from a poll into a notification. This is the best
*detector*, and the natural backstop behind the spray.

### 3. IPC polling on a local node

`MONAD_IPC_PATH` points the client at the node's unix socket: no TCP, no TLS, no HTTP framing.
Roughly a millisecond per read instead of tens. Implemented in
`packages/shared/src/transport.ts`, which prefers IPC → local WebSocket → local HTTP → remote.

### 4. Remote RPC polling — the naive baseline

Measured at **~116ms expected detection latency** (half a poll interval plus one round-trip)
against public endpoints. Polling faster than the round-trip cannot help; the benchmark reports
where that floor is. This is what a straightforward implementation does, and it is roughly two
orders of magnitude slower than method 1.

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

## Fee strategy

Monad leaders order by descending fee-per-gas, so the race is an auction and there is no
private mempool to route around it. Two consequences:

- **Bid to win.** The rescued position dwarfs any plausible fee; being outbid is the expensive
  outcome, not overpaying.
- **Escalate rather than guess.** `escalate.ts` pre-signs a ladder of increasing fees **sharing
  one nonce**, so at most one rung can ever be included. Start low, escalate only if a rung
  fails to land.

Note the ladder and the spray are different mechanisms and must not be confused: the ladder
shares one nonce (mutually exclusive attempts at one slot), the spray uses consecutive nonces
(independent attempts across time).

There is precedent that this is winnable: **Harpie** beat drainer bots on Ethereum at a claimed
~99.8% success rate using nothing but gas outbidding in the public mempool — no private relay.
Monad's default descending-fee ordering is the same lever.

---

## Layered defence, in firing order

1. **Before compromise** — the user delegates to their rescue contract and signs an
   authorization window. Nothing else works without this.
2. **On compromise signal** — `guard.ts` watches for a delegation change, a nonce advance, or
   an unexpected unstake. A delegation change is the loudest signal available: only one 7702
   delegation is active at a time, so a sophisticated attacker must re-delegate before they can
   steal atomically, which announces the attack.
3. **Through the window** — the spray keeps a transaction queued.
4. **At the flip** — detectors fire as a backstop if the spray is exhausted.
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
