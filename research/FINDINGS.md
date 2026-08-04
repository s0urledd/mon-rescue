# MonRescue — Phase 0 Findings

**Status:** Phase 0 partially resolved. Two questions are answered conclusively and one of
them is **negative**, which changes the architecture. The blocking question (Q1) is
documented-yes / **empirically UNVERIFIED** and needs a funded testnet key to close.

**Date:** 2026-08-03
**Networks probed:** Monad testnet (chainId `10143`), Monad mainnet (chainId `143`)
**Method:** live JSON-RPC against three independent endpoints, cross-checked against
`docs.monad.xyz` and against an independent validator API.

---

## 0. What was verified live, and how

Everything in this section was executed against live nodes during this research, not read
from documentation.

| Fact | Evidence |
|---|---|
| Monad **mainnet** is live | `eth_chainId` → `0x8f` (143), `eth_blockNumber` → 92,815,662, `web3_clientVersion` → `Monad/0.15.1` |
| Monad **testnet** is live | `eth_chainId` → `0x279f` (10143), block 50,569,116, `Monad/0.15.2` |
| Staking precompile address | `0x0000000000000000000000000000000000001000` — `eth_getCode` returns empty (0 bytes) yet balance is **4,352,942,279 MON**. Empty code + huge balance is the precompile signature. |
| The precompile is *live and answering* | `eth_call getEpoch()` → raw `0x…03f4…00` → decoded `(epoch=1012, inEpochDelayPeriod=false)` |
| The published ABI is **correct** | `eth_call getValidator(1)` decoded to `authAddress=0x92E8074D2DB345A2215e045A55CaA083c9eC023E, stake=26,160,638.227 MON, commission=0`. An independent validator API returned byte-identical values for the same validator, and the same epoch number. Two independent sources agree. |
| Reserve precompile is live | `eth_call dippedIntoReserve()` at `0x…1001` → `0x00…00` (false) |
| Real precompile traffic decodes correctly | The only selector seen targeting `0x…1000` over 900 blocks was `0x791bdcf3`, resolved via public 4-byte directories to **`syscallReward(address)`** — the consensus layer pushing the 18 MON/block reward. Its event `topic0` `0x3a420a…3754` matches `keccak("ValidatorRewarded(uint64,address,uint256,uint64)")` exactly. |
| Every documented selector is genuine | Local keccak of each signature reproduces the published selector exactly: `delegate(uint64)`=`0x84994fec`, `undelegate(uint64,uint256,uint8)`=`0x5cf41514`, `withdraw(uint64,uint8)`=`0xaed2ee73`, `claimRewards(uint64)`=`0xa76e2ca5`, `getEpoch()`=`0x757991a8`. |

Operational note: `eth_getLogs` on the public testnet endpoint is **capped at a 100-block
range** (`-32614: eth_getLogs is limited to a 100 range`). The watcher's backfill must page
in ≤100-block windows; this is a real constraint on indexer design.

---

## Q5 (asked late, answered first) — Can unstake/withdraw pay a different recipient?

### VERDICT: **NO. Conclusively no.** Payout is always to `msg.sender`.

This was the highest-value question, because a yes would have removed the race entirely.
It is a no.

```solidity
function undelegate(uint64 validatorId, uint256 amount, uint8 withdrawId) external returns (bool);
function withdraw(uint64 validatorId, uint8 withdrawId) external returns (bool);
function claimRewards(uint64 validatorId) external returns (bool);
```

**Not one of these takes an address parameter.** The only address-typed parameters anywhere
in `IMonadStaking` are on read-only views (`getDelegator`, `getWithdrawalRequest`,
`getDelegations`, `getDelegators`) which select *whose* record to read, never where to pay.

The reference states it directly: `withdraw` "Completes an undelegation action …, **sending
the amount to `msg.sender`**", the delegator "is determined by `msg.sender`", and the
pseudocode is `transfer(msg.sender, current_withdraw.amount + get_withdraw_rewards())`.
Storage is keyed `(val_id, msg.sender, withdrawal_id)`.

### Design consequence

The "bind the withdrawal to the safe address at unstake time and skip the race" plan is
**dead**. Funds always land on the delegator's own EOA. Therefore the rescue must be
**atomic claim-then-sweep inside a single transaction** — which is exactly what Q1 asks
about. Q1 is no longer merely the gate on a nice-to-have; it is the only remaining path.

---

## Q1 (BLOCKING) — Can the staking claim and a native transfer execute atomically in one 7702 batch?

### VERDICT: **Documented-yes, empirically UNVERIFIED.** Needs a funded testnet run.

What the documentation supports:

- Precompiles "are callable like any other contract via `CALL` or `STATICCALL`".
- The staking precompile constrains this further: "**Only `CALL` is allowed.** `STATICCALL`,
  `DELEGATECALL`, and `CALLCODE` will revert." A batch executor that dispatches with
  `to.call{value: v}(data)` satisfies this; one that uses `delegatecall` does **not**.
- Under EIP-7702 the delegated code runs *in the EOA's own context*, so at the precompile
  frame `msg.sender` is the EOA itself. The withdrawal therefore credits the EOA, and the
  next inner call in the same batch can forward it to the safe address.

What is **not** documented and must be tested: no source states that a staking-precompile
call succeeds specifically from inside a 7702-delegated account's batch execution. Per the
briefing's own rule, this stays **UNVERIFIED** rather than assumed.

### A trap that would brick an account

> "If an account delegates to the staking precompile address using EIP-7702, all calls to it
> will revert."

Delegating an EOA **to** `0x…1000` is fatal. This is distinct from our design (we delegate to
our own contract, which then *calls* `0x…1000`), but it is one address substitution away from
bricking a user's account. The rescue contract address must be validated against
`STAKING_PRECOMPILE` and `RESERVE_PRECOMPILE` before any authorization is signed.

### Script B closes this

`research/src/script-b-atomic.ts` performs the real test: delegate a funded testnet EOA to the
rescue contract, then in one `0x04` batch call `withdraw()` + transfer to a safe address, and
report whether both land in a single transaction.

---

## Q3 — The 10 MON reserve rule

### VERDICT: **FOUND — and the briefing's assumption was too pessimistic.**

The naive reading ("a delegated EOA must always retain 10 MON, so the last 10 MON is
unrescuable") is **wrong**, and acting on it would leave user funds behind.

The actual rule: at execution time, the ending balance of a **non-sender** account must not
fall below

```
min(balance at transaction start, 10 MON)
```

The floor is `min(start, 10 MON)` — **not** a flat 10 MON. Restating the documented bullets:

- Only transactions that **both** decrement the balance **and** end below the floor revert.
- A transaction that leaves the balance unchanged or higher never reverts, even far below 10 MON.
- Delegated EOAs cannot use the "emptying exception".
- To empty below the floor: undelegate first, then wait `k=3` blocks during which the account
  sends no other transaction and no delegation/undelegation request touches it.

In the rescue transaction the **guardian is the sender** and the victim EOA is a non-sender,
so the non-sender rule binds. Computed truth table (`packages/shared/src/reserve.ts`,
executed):

| EOA start balance | Inflow from claim | Floor | Sweepable | Stranded |
|---|---|---|---|---|
| 0 MON | 1000 MON | 0 | **1000 MON** | 0 |
| 5 MON | 1000 MON | 5 | **1000 MON** | 5 MON |
| 100 MON | 1000 MON | 10 | **1090 MON** | 10 MON |
| 3 MON | 0 | 3 | 0 | 3 MON |

### UNRESOLVED: the documentation contradicts itself, and it matters

Two statements in the docs cannot both be true for a delegated EOA:

- **Permissive reading** (reserve-balance page): "For a non-sender account, the ending balance
  must not be lower than `min(balance at transaction start, user_reserve_balance)`." With a
  start of 0, the floor is 0 — a full sweep is legal.
- **Strict reading** (EIP-7702 page): "transactions that would reduce its balance to below
  10 MON will **unconditionally** revert", where "dips below" means "decrements **and** drops
  below". Sweeping 1000 MON to 0 both decrements and ends below 10 — so it would revert.

The difference is the whole outcome: **sweep everything, or always strand 10 MON.**
`packages/shared/src/reserve.ts` implements the permissive reading, and **that choice is not
yet validated.** Script C exists specifically to settle it, and until it runs this is
**UNVERIFIED**. If the strict reading wins, `reserveFloor()` becomes a flat 10 MON and the
de-delegation branch stops being an edge case and becomes the normal path for a full recovery.

Do not quote the truth table above as fact until `research/artifacts/q3-reserve-balance.json`
exists.

### Design consequence, if the permissive reading holds

A compromised wallet whose liquid MON has already been drained starts at **~0**, so the floor
is ~0 and **the entire withdrawn stake can be swept in one transaction**. The reserve rule
barely bites in the exact scenario the product targets. The stranded amount is capped at
10 MON and only matters for an account that still holds a balance.

The guarded branch the briefing asked for is still required, but its trigger is
`min(start, 10 MON) > 0`, not "balance near 10 MON". Implemented as `planSweep()` /
`assertSweepAllowed()`, which throw before broadcast rather than letting a revert burn the
rescue window.

---

## Q6 — Epoch and unbonding timing

### VERDICT: **FOUND — epoch-boundary-precise, and the unlock block is NOT computable.**

- `WITHDRAWAL_DELAY` = **1 epoch**. A boundary block occurs every 50,000 blocks (~5.5h),
  followed by `EPOCH_DELAY_ROUNDS` = 5,000 rounds before the new epoch starts.
- For an `undelegate` in epoch *n*, stake becomes withdrawable in epoch
  **`n + 1 + WITHDRAWAL_DELAY`** if the request was before the boundary block, otherwise
  **`n + 2 + WITHDRAWAL_DELAY`**. `getEpoch()`'s `inEpochDelayPeriod` flag is exactly the
  "past the boundary block" signal.
- Critically: *"A round is not a block — rounds increment even on missed proposals. You cannot
  calculate epoch boundaries with modular arithmetic on block numbers. Always use `getEpoch()`."*

### CORRECTION — the unlock IS largely predictable, measured

An earlier version of this document concluded "there is no known unlock block" and designed
for blind polling. That was an over-reading of the documentation's warning. Measured on
testnet, with two independent archive nodes agreeing on every value:

| epoch | boundary block | first block of epoch | delay |
|---|---|---|---|
| 1009 | 50,400,000 | 50,404,999 | 4,999 |
| 1010 | 50,450,000 | 50,454,999 | 4,999 |
| 1011 | 50,500,000 | 50,504,999 | 4,999 |
| 1012 | 50,550,000 | 50,554,962 | 4,962 |

Two facts follow:

1. **The boundary block is exactly `(epoch - 1) × 50,000`.** That is plain arithmetic on block
   height, and it held for every epoch measured. `inEpochDelayPeriod` is already `true` at
   that block.
2. **The epoch then begins within `EPOCH_DELAY_ROUNDS` (5,000) of the boundary.** Rounds
   advance at least as fast as blocks — a missed proposal burns a round without producing a
   block — so the delay measured *in blocks* is bounded above by 5,000 and can only come in
   under it. Observed range: 4,962–4,999.

So the unlock is predictable to within about **40 blocks — roughly 12 seconds** at the
observed cadence. The documentation's warning ("you cannot calculate epoch boundaries with
modular arithmetic on block numbers") is about the *exact* block, not about total
unpredictability.

**Why this matters operationally:** it replaces four hours of blind polling with a ~30-second
burst. `packages/shared/src/schedule.ts` implements the phases — `idle` (sleep, poll every
30s), `approaching` (past the boundary, poll every 2s), `burst` (inside the flip window, poll
at the benchmark floor), `due`. That also means the rate limit we would have burned idling is
available exactly when it is needed.

Measured block cadence was **~0.301 s/block**, so an epoch is about **4.2 hours**, not the
~5.5 hours the documentation implies — the docs appear to assume 400ms blocks. Never schedule
against wall-clock; use block heights.

### Design consequence — this breaks a briefing assumption

The briefing planned to "pre-stage the claim+transfer and fire at a **known unlock block**".
**There is no known unlock block.** Rounds drift against blocks, so the boundary cannot be
predicted by arithmetic.

The hot path must therefore **poll `getEpoch()` at high frequency** (and/or watch
`EpochChanged`) and fire on the observed transition. Pre-signing is still correct — the
transaction is built and signed in advance — but the *trigger* is an observed epoch change,
not a block height. This makes low-latency polling against a low-latency node the single
most important engineering factor in the hot path, which in turn makes the operator's own
node a genuine competitive asset.

---

## Q2 — EIP-7702 support and submission path

### VERDICT: **FOUND (docs) / submission path UNVERIFIED (needs funded key).**

- Type `0x04` is supported "with the same workflow as in Ethereum": the EOA signs an
  authorization, and "the authorization can be submitted by the EOA themselves, **or by anyone
  else**" — which is precisely the gas-sponsored guardian model.
- The delegation indicator is `0xef0100 ‖ address`, so a delegation is **publicly readable via
  `eth_getCode`**. See the adversarial model below; this is a stealth leak.
- Delegation "remains valid in perpetuity unless another `0x04` transaction" changes it.
  Clearing = a `0x04` to the zero address.
- Delegated code cannot use `CREATE`/`CREATE2` (irrelevant to us; noted so nobody designs a
  factory into the delegated path).
- A canonical `Simple7702Account` is deployed on mainnet at
  `0xe6Cae83BdE06E4c305530e199D7217f42808555B`.

Scanning 40 consecutive testnet blocks found **zero** type-`0x04` transactions (only `0x0`,
`0x1`, `0x2`). That is not evidence against support — merely that 7702 is not in common use
on testnet, so we cannot confirm by observation and must submit one ourselves (Script A).

---

## Q4 — Guardian-triggered, destination-locked sweep

### VERDICT: **Design resolved; needs Script D to confirm on-chain.**

The reference implementation worth adapting (`codeesura/eip7702-asset-rescuer`) authorizes
**not** by `msg.sender` but by signature recovery:

```solidity
struct Call { address to; uint256 value; bytes data; }
function execute(Call[] calldata calls, bytes calldata signature) external payable;
// authorization: ECDSA.recover(toEthSignedMessageHash(digest), signature) == address(this)
// digest      : keccak256(abi.encodePacked(nonce, encodedCalls))
// nonce       : from an external Tracker contract, so any sponsor may broadcast
```

Because the code is delegated onto the EOA, `address(this)` **is** the user's address at
runtime, so only a signature from the user's key authorizes a batch — while anyone can pay
the gas. That is exactly the pre-authorization property we want, and it is Flashbots-free
already, so it ports to Monad cleanly.

**What we must change for MonRescue:** in that design an arbitrary `Call[]` is signed, so the
signer chooses the destination at signing time. Our safety property is stronger — the
destination must be **immutable and enforced by the contract**, so that even the attacker
triggering the function cannot redirect funds. Our contract therefore hard-codes the sweep
destination in immutable storage set at construction, and exposes no arbitrary-recipient path.

---

## Adversarial model — the attacker holds the seed

This is the section that decides whether the product is honest. Scope: **unbonding/staked MON**,
which is the defensible case. Liquid MON against a live seed holder is not cryptographically
defensible and we should not claim it is.

### What the attacker actually does — correcting an earlier over-weighting

An earlier draft of this document treated attacker **re-delegation** as the main threat. On
reflection that is wrong, and the correction matters.

The attacker holds the seed. To take unbonding MON they need no EIP-7702 at all — they send
two ordinary transactions from the EOA:

1. `withdraw(validatorId, withdrawId)` — the precompile pays `msg.sender`, so funds land on
   the EOA;
2. a plain native transfer out.

Re-delegation is only worth their trouble if they want **atomicity** — to close the gap
between those two transactions. So there are two distinct adversaries:

- **The ordinary attacker** uses two plain transactions and *leaves us a window between them*.
  This is the common case and the one we are built to win.
- **The sophisticated attacker** re-delegates to their own batch contract to close that window.
  Only this one is defeated by the authorization window in Q8.

Two consequences follow, and both were missed initially:

**Our delegation is itself a brake on the attacker.** A delegated EOA cannot drop below the
reserve floor, and delegated accounts cannot use the emptying exception. So while our
delegation stands, the attacker's plain transfer cannot fully empty the account — to do that
they must first undelegate and then wait `k=3` quiet blocks. That is both a delay and a loud
on-chain signal. The delegation is not only our rescue path; it is a passive speed bump on
theirs. (Subject to the Q3 ambiguity above.)

**A failed withdrawal often means the money is right here.** If the attacker's `withdraw()`
lands first, the funds are sitting on an EOA that is still delegated to a destination-locked
contract. `rescue()` therefore does **not** abort when every withdrawal fails — it proceeds to
sweep, because the most likely cause of that failure is precisely that the money has already
arrived. An earlier version reverted in that case and would have thrown away the rescue at the
exact moment it could succeed.

### Our real edge

Two things, and neither is cryptography:

1. **Automation vs. a human.** We fire on an observed epoch transition in milliseconds from a
   pre-signed transaction. A manual attacker will not.
2. **Surprise.** The attacker does not know a guardian is pre-staged. This is a genuine asset
   and it must be *designed for*, not assumed.

### The stealth leak, and the countermeasure

A 7702 delegation is **public**: `eth_getCode(victim)` returns `0xef0100 ‖ rescueContract`. If
MonRescue deploys one well-known singleton rescue contract, then any attacker who checks the
victim's code sees a known MonRescue address and knows to re-delegate first.

**Countermeasure:** deploy a **per-user rescue contract instance** (each with its own immutable
safe address). Each user's delegate target is then a distinct, unremarkable address rather than
a fingerprint that appears in every protected wallet. This is not security-by-obscurity as a
substitute for the destination lock — the destination lock holds regardless — it is preserving
the one advantage we actually have. Note the delegated code itself cannot use `CREATE`/`CREATE2`,
but the *factory* is an ordinary contract, so this is unconstrained.

### Attacker counter-moves, and our answer to each

| Attacker move | Effect | Our answer |
|---|---|---|
| Re-delegate the EOA to their own drainer (`0x04`) | Destroys our delegation | **Only one delegation is active at a time.** Their re-delegation is a visible on-chain state change; the watcher treats "delegation target changed" as a maximum-priority compromise signal. |
| Clear the delegation (`0x04` → zero address) | Disables our rescue path | Same detection. Also re-enables *their* emptying exception after k=3 blocks — so this move is a strong tell, not a quiet one. |
| Call `undelegate()` themselves | Starts their own unbonding clock | Works in our favour: it is a loud signal and the unlock is still epoch-bound, giving us ≥1 epoch to prepare. |
| Call `withdraw()` alone at unlock | Moves funds to the **EOA**, not to them | This *helps us*: it converts staked MON into liquid MON sitting in an EOA that is still delegated to our destination-locked contract. Our sweep takes it. To actually steal, they need a second transaction — and that gap is our window. |
| Atomic withdraw+transfer of their own | Would beat us | Requires them to re-delegate first (one delegation at a time), which is the loud signal above. A drainer that does this has told us before it acts. |
| Occupy `withdrawId` slots | **Real griefing vector** | `undelegate` "will revert if there is a pending withdrawal with the same `withdrawId`", and `withdrawId` is a `uint8` — only 256 slots per (validator, delegator). An attacker can deliberately exhaust them. The rescue path must scan for a free slot and alert loudly when the space is nearly full. Not yet mitigated; flagged as an open design item. |
| Front-run our withdraw at the epoch boundary | Pure ordering race | Multi-RPC simultaneous broadcast, minimum latency to the leader, aggressive priority fee. Rescued value vastly exceeds fees, so we bid to win. |

### The honest limitation

A seed holder who is *sophisticated and paying attention* can re-delegate and beat us. Our
claim is bounded and should stay bounded: MonRescue **materially improves the odds for
unbonding MON against an unattended or unsophisticated drainer**, and offers no cryptographic
guarantee against an alert one. Tier 2 (a smart account where the seed is only one of several
signers, with a withdrawal timelock a guardian can veto) is the only family that actually
defeats a live seed holder — it is a migration, not a retrofit, and belongs on the roadmap.

---

### Non-negotiable invariant: no seed, no private key, ever

MonRescue must never ask a compromised user for a seed phrase or a private key, and must
provide no code path capable of accepting one. This is a transparency and liability property
as much as a security one: a rescue service that collects seeds is indistinguishable from a
phishing operation, and asking for one trains users into exactly the behaviour that gets them
drained.

Structurally, the only artifacts a user ever produces are signatures made **in their own
wallet**:

1. an **EIP-7702 authorization** delegating their EOA to their rescue contract instance, and
2. a **pre-signed rescue payload** authorizing the destination-locked sweep.

The guardian key is *ours*, is supplied at runtime, and can do exactly one thing: pay gas and
broadcast an already-authorized transaction. It grants no authority over user funds — the
destination is fixed in the contract's immutable storage.

Enforcement, so this is a property of the code and not a promise in a README:

- No package in this repository exposes a mnemonic or raw-private-key import path for a
  *protected* address. `viem`'s `privateKeyToAccount` appears only where the key is the
  operator's own guardian key or a research test key, never a user's.
- The approval subpage must be wallet-signature only, with no key entry field.
- Any future contributor adding a key-import path for a protected address is changing the
  security model and should be treated as such in review.

---

## Consolidated design consequences

1. **No recipient binding (Q5)** → the rescue *must* be an atomic claim+sweep. Q1 is the whole
   product; there is no fallback that avoids the race.
2. **No computable unlock block (Q6)** → trigger on observed `getEpoch()` transitions, not on a
   scheduled block. Low-latency polling is the core engineering problem.
3. **Reserve floor is `min(start, 10 MON)` (Q3)** → a drained wallet can be swept ~completely.
   Guard the branch, but do not design around a flat 10 MON loss.
4. **Only `CALL` reaches the precompile** → the batch executor must use `call`, never
   `delegatecall`. All precompile "views" are `nonpayable`, so `eth_call` + manual decode is
   required off-chain (viem's `readContract` will not work).
5. **Never delegate an EOA to `0x…1000`** → validate the delegate target before signing.
6. **Delegations are public** → per-user rescue contract instances to preserve surprise.
7. **`eth_getLogs` is capped at 100 blocks** → the watcher pages its backfill.

---

## Q7 — How is transaction ordering actually decided on Monad?

This was not in the original question set but it turned out to be the question the hot path
lives or dies on.

- **There is no global mempool.** Each validator keeps a *local* mempool, and RPC nodes
  forward transactions to the **next 3 upcoming leaders**.
- **Ordering defaults to a Priority Gas Auction**: the leader "adds transactions to their
  block as they see fit — default: ordered by descending fee-per-gas-unit."
- **No Flashbots equivalent exists, and one is unlikely soon.** bloXroute's BackRunMe does not
  list Monad, and the Monad Foundation's validator delegation policy states that systems
  "that centralize order flow" or "give a third party authority over block building" are
  counter to the programme's objectives. Threshold-encrypted mempools (BTX) and multiple
  concurrent proposers (Cadence) are described as future work, not deployed.

### Design consequence — and an encouraging precedent

Ordering is winnable by **fee bidding plus low latency**, and nothing else. That is exactly
what `broadcastEverywhere()` and the priority-fee multiplier implement.

The precedent matters: **Harpie** ran a production wallet-firewall on Ethereum that beat
drainer bots by **outbidding gas in the public mempool with no private relay at all**, at a
claimed ~99.8% success rate, classifying threats in ~20ms. Monad's default descending-fee
ordering is the same lever. So "we have no private mempool" is not the disqualifier it first
appears to be — it is the condition Harpie already operated in successfully.

Two further constraints that bite the hot path specifically:

- **Per-account inflight gas budget.** Total gas spend across an account's inflight
  transactions (last k=3 blocks) is capped at `min(10 MON, lagged balance)`. An aggressive
  retry loop from one guardian address will hit this ceiling — retries must be bounded.
- **Included-but-reverted is a normal outcome.** Proposers cannot see current state, so a
  transaction that overspends is still included and still pays gas. The tooling must
  distinguish "not included" from "included and reverted" rather than treating both as failure.

---

## Q13 — What multi-endpoint broadcast actually buys

Worth recording because I got this wrong twice, in opposite directions.

**Documented, verbatim:**

- *"Since the function is deterministic, everyone arrives at the same leader schedule."*
- *"the consensus process forwards the transaction to `N` upcoming leader validator nodes.
  Currently, `N` is set to 3 in Monad testnet and mainnet."*
- *"**The owner node** of the transaction monitors for that transaction in subsequent blocks. If
  it doesn't see the transaction in the next `N` blocks, it will re-send to the next `N` leaders.
  It repeats this behavior for a total of `K` times. Currently, `K` is set to 3."*

**First claim (wrong):** fanning out reaches more leaders. Overstated — the schedule is shared,
so no endpoint knows a leader another does not.

**Second claim (also wrong):** therefore fan-out buys nothing but failover. That missed the third
quote. The retry cycle belongs to **the owner node**, so every endpoint submitted to becomes an
independent owner running its own `K=3` cycle of re-forwarding. Across the retry window that is
genuinely broader forwarding, reaching leaders further down the schedule — three owners means up
to three independent retry cycles rather than one.

**What actually holds:**

| | |
|---|---|
| At the first submission, nodes in sync | same three leaders — no coverage gain |
| Across the retry window | real gain: independent `K=3` cycles per owner node |
| If any node is out of round-sync | partially different leader set (see below) |
| If our node is down or throttled | fan-out is the only thing that saves the rescue |

**UNVERIFIED:** that all nodes compute the same "next `N`" at the same instant. The docs never
say this. Which leaders are *next* depends on the round a node currently believes is current, and
rounds advance on timeout whether or not a block is produced — so a lagging node forwards to a
partially different set. This is inference, and it is the kind that should be measured rather
than argued about: submit the same transaction to several endpoints and compare which leaders it
reaches.

---

## Q12 — Epoch-transition mechanics (two exploitable details)

### The flip block is targetable — the epoch changes in transaction 0

Measured at the epoch 1011→1012 transition, block 50,554,962:

| txIndex | selector | what |
|---|---|---|
| 0 | `0x1d4e9f02` | `syscallOnEpochChange(uint64)` — emits `EpochChanged` |
| 1 | `0x791bdcf3` | `syscallReward(address)` |
| 2+ | — | ordinary user transactions |

The epoch advances in the **first transaction of the block**, before any user transaction runs.
So a `withdraw()` landing in the flip block itself already sees the new epoch and succeeds.

**Aim at the flip block, not the block after it.** Targeting one block late concedes 300ms and a
whole block's worth of competing transactions for no reason.

### The boundary block moves maturity by a full epoch

The snapshot for the next epoch is taken at the **start** of the boundary block, before user
transactions. So for an `undelegate`:

- landing **before** the boundary block → activates at `n+1`, matures at `n+2`
- landing **in or after** the boundary block → activates at `n+2`, matures at `n+3`

That is a difference of one full epoch — about **4.2 hours** — decided purely by which side of a
single block the transaction lands on.

In an emergency this is the largest lever available on the clock, and it is invisible unless
specifically checked. `undelegateTiming()` computes the deadline and the emergency intake prints
it before anything else, including in the case where nothing has been unbonded yet — which is
exactly when the advice is worth the most.

Worked example from a live run: at epoch 1012, block 50,582,959, the deadline was block
50,600,000 — about 1.42 hours to act before the cost became an extra 4.2 hours of waiting.

---

## Q9 — What actually fires the rescue? (the mechanism question)

Everything above says *when*. This says *who and how*, which turns out to have a
counter-intuitive answer.

### The unstake → withdraw timeline, concretely

```
epoch n         undelegate(valId, amount, withdrawId)
                  -> creates a withdrawal request; stake stops earning
                  -> claimable at epoch n+2 (request before the boundary block)
                                or epoch n+3 (request after it)
                     because WITHDRAWAL_DELAY = 1 and the request lands in n+1 or n+2

...wait 2-3 epochs, roughly 8-13 hours at ~4.2h per epoch...

boundary block  = (targetEpoch - 1) x 50,000        <- deterministic
+4,900 blocks   -> earliest the epoch can begin      <- start burst-polling here
+5,000 blocks   -> latest the epoch can begin        <- it has flipped by now

epoch target    withdraw(valId, withdrawId) pays msg.sender
                  -> in our design, the SAME transaction sweeps to the safe address
```

Worked example from a live reading: at epoch 1012, block 50,576,907, undelegating right then
gives an unlock epoch of **1014**, boundary block **50,650,000**, and the epoch beginning
between blocks **50,654,900 and 50,655,000** — about 6.1 hours out.

### Four ways to fire it, and why three of them are wrong

**(a) The contract fires itself.** *Impossible.* Nothing on an EVM chain self-executes; every
state change needs someone to send a transaction and pay gas. There is no `onTimer` hook. Any
design that says "the contract sends automatically at the unlock" is really design (b) or (d)
with the keeper left unspecified. Worth stating plainly because it is the most natural thing
to assume.

**(b) The user does withdraw + send manually.** Works, but it is two transactions with a gap
between them, and it needs the user awake and watching at a boundary that lands at an
arbitrary hour. Against an automated drainer the gap is the whole vulnerability. This is the
thing our atomic single transaction exists to replace.

**(c) A guardian-only daemon.** What we built first, and it has a single point of failure that
is precisely aligned with the moment of maximum stakes: if our process is down, rate-limited,
out of gas, or mid-deploy at the unlock block, the funds are lost and nothing else can act.

**(d) Permissionless trigger — adopted.** `rescue()` and `sweep()` are callable by **anyone**.

This looks reckless and is not, because of the destination lock: funds can only ever reach
`SAFE_ADDRESS`. The worst an arbitrary caller can do is pay gas to move the user's money to
the user's own safe address. **Even the attacker calling it is a win for us.** Access control
here would buy nothing and cost the one thing that actually matters — liveness.

So the trigger set becomes: our daemon, the user's own machine, a friend's script, any keeper,
all racing, first to land wins and only that one pays. Redundancy beats exclusivity when the
failure mode is "nobody fired in time". `GUARDIAN` remains on the contract as published
metadata identifying the intended primary trigger, not as a permission.

### What the daemon does during the wait

It is not a busy loop. It sleeps through `idle`, wakes as the boundary block approaches, holds
a pre-signed transaction (and a pre-signed fee ladder) in memory, and bursts only inside the
~100-block flip window. Signing anything at fire time would add milliseconds at the moment
they are most expensive.

---

## Q11 — Precompile edge cases that the documentation gets wrong

Reading the upstream implementation alongside the docs surfaced several places where the
documentation is incomplete or actively wrong. Each of these was a live or latent bug here.

### `withdrawEpoch` is NOT the maturity epoch — this was an off-by-one bug

The `WithdrawalRequest` struct comment says *"Epoch when undelegate stake deactivates"*, but the
`undelegate` pseudocode on the same page stores `epoch = getEpoch()` — the current epoch. These
cannot both be true. The struct comment is correct: the stored value is `n+1` (or `n+2` past the
boundary block), i.e. the **activation** epoch.

Maturity is therefore **`withdrawEpoch + WITHDRAWAL_DELAY`**, not `withdrawEpoch`.

`isClaimable()` originally compared against `withdrawEpoch` directly, which would have fired
every rescue one full epoch early. The call reverts with `"withdrawal not ready"` — and since an
invalid staking-precompile call **consumes all gas in its frame**, and Monad charges the gas
limit rather than gas used, the mistake is expensive as well as useless. Fixed in
`packages/shared/src/epoch.ts`.

### `getDelegations()` is not a complete source of truth

Once a delegator's next-epoch stake reaches zero, the precompile removes them from the delegator
linked list — **while their pending withdrawal requests still exist and remain claimable**. A
user who unbonded their entire position, which is precisely the case this project targets,
vanishes from `getDelegations()` while still having funds to rescue.

Withdrawals must therefore be enumerated by probing `getWithdrawalRequest` per slot, with
validator ids carried from a stored watch or a prior `Undelegate` event rather than rediscovered.
`loadPortfolio()` now takes explicit extra validator ids for this reason.

### Probe with `getWithdrawalRequest`, never with `withdraw`

`getWithdrawalRequest` on an empty slot returns `(0, 0, 0)` and does **not** revert, so it is
safe to scan with. A live request always carries a non-zero epoch, so `withdrawEpoch == 0` means
"empty".

`withdraw()` on an empty slot reverts with `"unknown withdrawal id"`, and burns the whole call
frame's gas doing so. A naive rescue loop over all 256 ids would be ruinous.

### The withdrawal can pay out MORE than it says

Two mechanisms, neither obvious:

- **Dust sweep.** If an `undelegate` would leave less than `DUST_THRESHOLD` (1 gwei) of stake
  behind, the precompile silently increases the withdrawal to the delegator's *entire remaining
  stake*. The realised amount can exceed the amount requested.
- **Accrued rewards.** `withdraw()` pays `request.amount + rewards accrued to the request`, since
  each withdrawal request behaves like an independent delegator until it matures.

So never assert equality against `getWithdrawalRequest.amount`; read the `Undelegate` event or
the balance delta.

### `undelegate` has no minimum amount, but `claimRewards` never fails

`DUST_THRESHOLD` applies only to `delegate`. `undelegate` accepts any non-zero amount; a zero
amount is a silent no-op returning `true`.

`claimRewards` on a non-existent delegator or with zero rewards **succeeds and returns `true`,
emitting no event** — contradicting the docs, which claim it reverts. A `true` return is not
proof that MON moved; check the log or the balance.

### Validator flags are a bitmask, and a dead validator still pays out

`ValidatorFlagsOk = 0`, `StakeTooLow = 1`, `Withdrawn = 2`, `DoubleSign = 4` — combinations are
valid, so test `flags & 1` rather than `flags == 1`. There is no jailing mechanism and no
automated slashing.

Most importantly: **nothing in `undelegate` or `withdraw` reads the validator's flags or checks
valset membership.** Funds are recoverable from a fully dead or removed validator. Validator ids
are permanent for exactly this reason.

---

## Q10 — The `withdrawId` griefing vector, resolved

Earlier drafts listed this as an open, unmitigated attack. **It is not a vector at all**, and the
reason is worth recording.

Withdrawal slots are keyed `(namespace, validatorId, msg.sender, withdrawId)`, and `undelegate`
binds the delegator to `msg.sender` unconditionally. **A third party cannot create, occupy, or
touch another delegator's slots at any price.** Only the victim's own key can fill the victim's
256 slots — and anyone holding that key can simply withdraw instead. Slot exhaustion is a
self-inflicted condition, not something an outsider can inflict.

What remains true is much narrower: an attacker *who already holds the key* can fill slots to
block us from creating new withdrawal requests. But filling them with real stake hands us 256
claimable requests our batch rescue can drain, and filling them with dust still leaves us the
option of withdrawing the dust to free a slot. It is a delay, not a lockout, and it is loud.

---

## Q10a — The original framing (kept for the record)

An earlier version listed this as an unmitigated attack and overstated it. Correcting.

**The mechanism:** `undelegate` reverts if a pending withdrawal already occupies the same
`withdrawId`, and `withdrawId` is a `uint8`. Storage is keyed
`(validatorId, msg.sender, withdrawId)`, so the 256 slots belong to **the delegator**, not to
the world. Only someone holding the user's key can fill them — which the attacker does.

**It does not cancel an existing undelegation.** A withdrawal request already created while
the wallet was safe cannot be removed by filling slots; it still matures and is still
claimable. The vector only blocks the creation of *new* requests.

**Why it is weaker than it first appears:** filling slots costs the attacker 256 transactions,
and if they fill them with real stake they have unbonded that stake into 256 claimable
requests — all of which pay `msg.sender`, i.e. the account we are delegated to, and all of
which our batch `rescue(uint64[], uint8[], bool)` can drain. Griefing us that way hands us the
funds.

**Where it still bites:** if `undelegate` permits dust-sized amounts, the attacker can fill all
256 slots for a negligible cost while leaving the bulk of the stake bonded, and we then cannot
create a withdrawal request for the real position. Our counter is to `withdraw()` the dust
slots to free them and then undelegate — which costs an epoch, so it is a delay rather than a
permanent block, and it is very loud on-chain.

**Status: UNVERIFIED.** Whether `undelegate` enforces a minimum amount decides whether this is
a real vector or a self-defeating one. `DUST_THRESHOLD` (1 gwei) is documented for `delegate`;
whether it also applies to `undelegate` is not stated. This needs a testnet script.

---

## Q8 — Can the attacker permanently block us? (anti-blocking)

The attacker holds the seed, so assume they will try to **lock us out**, not merely outrun us.
Resolved against the EIP-7702 specification (Final).

### The finding that changes the picture

> "The authorization list is processed **before the execution portion of the transaction
> begins**, but after the sender's nonce is incremented."

A single type-`0x04` transaction therefore does, in order: apply our authorization, then run
the top-level call. So the rescue transaction can **re-assert our delegation and execute the
rescue atomically**. An attacker re-delegating the EOA to their own drainer is *not* a
permanent lockout — it is something we undo inside our own transaction, in the same block.

This is the single most important anti-blocking property available to us.

### The nonce problem, and the window that solves it

Authorizations are validated by **strict equality** against the authority's current nonce
(step 6), and applying one **increments** that nonce (step 9). There is **no expiry field at
all** — an authorization is valid indefinitely, and the only way to invalidate one is to spend
its nonce. So:

- One pre-signed authorization is valid only while the account sits at exactly that nonce.
- Any transaction the attacker sends from the EOA invalidates it.

**Countermeasure: pre-sign a window of authorizations at nonces `[n, n+16)` during onboarding.**
At rescue time we submit every authorization at or above the current nonce, so bumping the
nonce buys the attacker one transaction of delay, not a lockout. An authorization with a wrong
nonce is *skipped*, not fatal — "immediately stop processing the tuple and continue to the next
tuple" — it only costs ~25k gas.

### The chaining hazard, and why the destination lock neutralises it

The spec warns that consecutive authorizations **chain** inside one transaction: each success
increments the nonce, making the next tuple match, and "the last valid occurrence" wins. For a
general-purpose wallet that is a real hazard.

**For MonRescue it is harmless, and that is a consequence of the destination lock.** Every
authorization in the window names the same rescue contract, so whether one applies or all
sixteen do, the account ends up delegated to the same destination-locked code. The outcome is
identical.

The same property bounds a key-store breach: these signatures let the holder delegate the
user's account to a contract that can only pay **the user's own safe address**. A leaked
authorization window is a nonce-griefing problem, not a fund-loss problem.

### Attacker blocking moves, reassessed

| Blocking move | Previously | With the authorization window |
|---|---|---|
| Re-delegate to their drainer | **Blocked us** | Undone inside our rescue transaction, before the call runs |
| Clear the delegation | **Blocked us** | Same — we re-assert |
| Bump the nonce to stale our authorization | **Blocked us** | Costs them one transaction; the window still covers us |
| Exhaust the window (16+ transactions) | — | **Still wins.** Detected by `assessWindow()`, which asks the user to re-sign while they still can |
| Occupy all 256 `withdrawId` slots | Open | **Still open.** Documented, unmitigated |
| Outbid us on priority fee | Open | Pre-signed fee ladder, all rungs sharing one nonce so at most one lands |

### Two implementation traps that fail *silently*

1. **`executor: 'self'` changes the nonce viem signs.** When the authority is also the
   transaction sender, the sender's nonce is incremented *before* the authorization list is
   processed, so the authorization must be signed at `nonce + 1`. viem does this only when
   `executor: 'self'` is set and `nonce` is not passed explicitly. Get it wrong and the
   authorization is silently skipped: the transaction still succeeds, ~25k gas is burned, and
   **no delegation is applied**. Our guardian-submitted rescue is the *relayer* case, so it
   must NOT use `executor: 'self'`; scripts A–C are self-submitted and must.
2. **A reverting call does not roll back the delegation.** "If transaction execution results in
   failure … the processed delegation indicators is *not* rolled back." Never rely on a revert
   to undo a re-delegation, and never assume a failed rescue left the account untouched.

### Also rejected: `chainId = 0`

An authorization signed with `chainId = 0` is valid on **every** chain and never expires. Since
MonRescue runs on two live chains, `validateWindow()` refuses these outright. This is the same
class of bug as the cross-chain replay Sherlock found in Harpie.

---

## Prior art — what to copy, and one warning

### Harpie (`github.com/Harpieio/contracts`) — the closest architectural match

Harpie is the strongest blueprint found, and it independently arrived at our core design.
Its `Transfer.sol` holds the destination as an **immutable constructor parameter**, so even a
compromised Harpie server key could not steal — it could only push assets into the user's
vault. That is precisely the destination-lock property MonRescue is built around, which is
reassuring: the design has been audited (Sherlock, 2022) and run in production.

Three concrete things adopted from it:

1. **Per-call gas cap plus continue-on-failure** in batch rescues, so one bad position cannot
   revert the whole operation. Implemented as `WITHDRAW_GAS_CAP` with `WithdrawFailed` events
   and an `AllWithdrawalsFailed` guard.
2. **Sherlock finding M-2 — cross-chain replay.** Harpie's signed recipient-change payload
   omitted `chainId`, allowing a signature to be replayed on another chain. MonRescue runs on
   two live chains (143 and 10143) with the same addresses in play, so **every signed guardian
   payload must bind `chainId`**. Flagged as a hard requirement for the approval subpage.
3. **Sherlock M-1** — use `safeTransferFrom` semantics for any future token support; a plain
   transfer breaks recipients with receive hooks.

**The warning:** Harpie **shut down in March 2025**, having raised $4.5M, explicitly because
the business model did not generate enough revenue — while charging a flat 0.01 ETH per
rescue. Rescue-as-a-service is a demonstrated hard sell. This is a product-strategy input,
not a technical one, and it supports shipping the alert engine (recurring, broad appeal)
ahead of the rescue tool (rare, high-stakes, hard to monetise).

### Other prior art worth knowing

- **`pcaversaccio/white-hat-frontrunning`** (AGPL-3.0 — copyleft, so read, don't copy):
  its `go_eip7702.sh` implements a paymaster model that moves assets **without ever sending
  ether to the compromised wallet**, then **resets the 7702 authorization afterwards**. The
  "never fund the victim" idea is directly applicable — a balance-triggered sweeper never
  sees a trigger event.
- **`mpeyfuss/eth-rescue`** (MIT): clears any pre-existing 7702 delegation as step 1 of its
  bundle. Worth adopting — an attacker may have already delegated the victim to their own
  sweeper, and we should detect that rather than assume a clean slate.
- **`flashbots/searcher-sponsored-tx`**: the canonical sponsored-transaction rescue. The
  pattern transfers to Monad; the bundle-relay transport does not.
- **ERC-7821** is the emerging standard batch-executor interface
  (`execute(bytes32 mode, bytes executionData)`), implemented by Uniswap's **Calibur**
  (MIT, audited by OpenZeppelin *and* Cantina) and Solady. Notably, Solady's doctrine puts a
  guardian signature in `opData` — the standards-sanctioned slot for exactly our trigger
  model. Aligning with ERC-7821 is a sensible v1 refactor once Q1 is closed.
- **Social recovery is the wrong tool.** Argent, Safe recovery modules, ERC-7947 and Vitalik's
  social-recovery writing all solve the **lost key**, not the **stolen key**. The only family
  that defeats a live seed holder is a **withdrawal timelock with a guardian veto** — and it
  requires a true smart-contract account with no controlling EOA key. This confirms the Tier 1
  / Tier 2 split: Tier 1 buys speed and atomicity, never authorization exclusivity.

---

## Tier 2 — what actually defeats a live seed holder

A survey of the smart-account recovery ecosystem (Safe, Candide, Ambire, Rhinestone, ZeroDev,
Coinbase Smart Wallet, Biconomy Nexus, ERC-4337 reference) produced one finding that reframes
the roadmap.

### Almost every "recovery" product solves the wrong problem

There are two distinct threat models and the industry conflates them:

- **Lost key** — the owner can no longer sign. Recovery re-establishes a signer.
- **Compromised key** — the attacker holds the key *right now* and is draining.

**Safe's recovery module, Candide, ZeroDev Kernel recovery, Rhinestone's SocialRecovery, and
Biconomy all solve only the lost-key case.** Their timelocks delay the *guardian's* action —
protecting the owner from malicious guardians — not the *withdrawal*. Against a live attacker
holding a threshold-1 owner key, the attacker drains in one transaction and can additionally
call `cancelRecovery()` as the legitimate owner to block the recovery.

**Coinbase Smart Wallet is worse than useless here**: its recovery key is simply another
unilateral owner, so an attacker who obtains it can drain *and* remove the real user's passkey,
locking them out permanently. This is an anti-pattern to avoid, not a model to copy.

### The two designs that genuinely work

1. **Rhinestone `ColdStorageHook`** (AGPL-3.0, audited by Ackee 2024-10-03) — the direct hit.
   `VaultConfig { uint128 waitPeriod; address owner; }` where `owner` is the *only* permitted
   transfer recipient, enforced by decoding the outgoing calldata. Because it is an ERC-7579
   **type-4 hook**, it runs on every execution path, so a compromised root key cannot route
   around it. Destination lock plus withdrawal timelock, already shipped.
2. **Ambire's email/password account** — 2-of-2 for immediate execution; a single stolen key
   can only transact after a **3-day timelock**, during which the other key cancels or evacuates.

### The citable authority on why Tier 1 is bounded

Rhinestone's own EIP-7702 documentation states it plainly: *"the EOA is always the root
owner"*, *"No key rotation"*, *"if the EOA is compromised, the account cannot be recovered"*.
No 7702 delegate in production today solves the compromised-seed case, because the seed can
always sign a new type-`0x04` authorization. Our Tier 1 framing matches industry consensus
exactly — we should ship it with that caveat stated, not softened.

### Where MonRescue is actually novel

No surveyed product combines all three of: **guardian-triggered** + **destination-locked** +
**timelocked/epoch-gated withdrawal**. `ColdStorageHook` has the destination lock and the
timelock but no guardian trigger; Ambire has commit-plus-timelock and a recovery-key trigger
but no destination lock. On Monad the unbonding delay supplies the timelock *for free* — the
protocol already forces the attacker to wait. That combination appears to be genuinely new.

### Licensing caution

Rhinestone's core-modules and all Ambire contracts are **AGPL-3.0**. MonRescue is MIT. Reading
them for design is fine; copying their enforcement logic would make our contracts AGPL. If a
permissively-licensed equivalent is needed, MetaMask's delegation-framework caveat enforcers
(`AllowedCalldataEnforcer`, `ExactCalldataEnforcer`, Apache-2.0/MIT) implement the same
destination-pinning primitive.

### Roadmap consequence

Tier 2 should be **`ColdStorageHook`-shaped, not social-recovery-shaped**, built as an
ERC-7579 hook. That is a different product from Tier 1 and belongs behind it, not blended into
it. Whether Monad has ERC-4337/7579 infrastructure deployed is an open question for a later
phase — not answered here.

---

## Status of the Phase 1 gate

| Question | Verdict | Blocking? |
|---|---|---|
| Q1 atomic claim+transfer in one 7702 batch | Documented-yes, **UNVERIFIED** | **YES — needs funded testnet key** |
| Q2 7702 / `0x04` submission via viem | Documented-yes, submission UNVERIFIED | Closed by Script A |
| Q3 reserve rule | **RESOLVED** (floor = `min(start, 10 MON)`) | No |
| Q4 guardian-triggered destination-locked sweep | Design resolved, on-chain UNVERIFIED | Closed by Script D |
| Q5 recipient binding | **RESOLVED — NO** | No (architecture updated) |
| Q6 epoch/unbonding precision | **RESOLVED** (epoch-precise, block not computable) | No |

**Gate decision:** the alert engine (`watcher/`) is unblocked and should ship first — it depends
only on facts already verified live. The rescue hot path (`rescue-cli/`) and the contract are
scaffolded with the verified constraints encoded, but **must not be presented as working until
Script B returns a passing transaction hash on testnet.**

To close the gate, fund a testnet key and run `pnpm --filter @monrescue/research verify`, then
scripts A→D in order. Each script writes its transaction hashes into `research/artifacts/`.
