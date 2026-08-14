# MonRescue — Phase 0 Findings

**Status: Q1 IS ANSWERED — YES.** On 2026-08-06 a single EIP-7702 transaction claimed three
matured withdrawals from the staking precompile and swept 500.112413 MON to the destination-
locked safe address, in one block, fired by a guardian key that never held the victim's key.
The blocking assumption the whole design rested on is now measured rather than argued.

Q2 verified, Q3 resolved, Q5 answered (negatively, which set the architecture), `withdrawEpoch`
semantics confirmed. Q4 is closed as a side effect of the Q1 run: the guardian fired it.

**Date:** 2026-08-03, updated through 2026-08-06 with on-chain results
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

### VERDICT: **YES — measured on testnet, 2026-08-06.**

Transaction `0x6c285d49425cd829bb74dc784818fcbd0279a8fcb4fa0736c98460d2b313e17b`, block
**51,416,783**:

| | |
|---|---|
| sender | the guardian — never held the victim's key |
| target | the victim EOA, delegated to the rescue contract |
| `Withdraw` events from `0x…1000` | **3** |
| safe address | 4.806452 → 504.918865 MON |
| delivered | **500.112413 MON, in a single block** |
| victim retained | 5.043105 MON — exactly the reserve floor |
| status | success |

Three matured withdrawals were claimed from the staking precompile and the proceeds swept to
the destination-locked address **with no intervening block**. There is no window in which the
claimed MON sits in a wallet the attacker controls. That was the one thing the architecture
could not survive being wrong about.

The delivered amount exceeds the 500 MON of principal by 0.112413 MON: rewards accrued to the
withdrawal requests themselves, which `withdraw()` pays regardless — consistent with Q11.

**Q4 closed with it.** The transaction was sent by the guardian, whose key cannot choose a
destination, against a contract whose `SAFE_ADDRESS` is immutable. A separate guardian firing a
destination-locked sweep is no longer a design claim.

### One thing this does NOT establish

`gasUsed` reads **350,000 of a 350,000 limit** — exactly the limit, as it also did on the run
that ran out of gas. Monad charges the limit rather than the usage, so the receipt reports what
was charged, not what was consumed. **We cannot see how much headroom this transaction had.**

So the success at 350k is one data point, not evidence that 350k is generally sufficient — and
the same limit failed on the previous attempt against the same three positions. Until actual
consumption can be measured some other way, `estimateRescueGas()` and its ~970k for three
positions remains the safer default, and the earlier finding stands: being short is fatal
because the precompile consumes all gas, while being long only costs the difference.

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

### RESOLVED — measured on testnet 2026-08-04, and the "contradiction" was largely illusory

`script:c` ran against a delegated account holding 4.8633 MON:

| case | test | result |
|---|---|---|
| 1 | transfer 0.5 MON, ending below the floor | **reverted**, as predicted |
| 2 | transfer to land exactly on the floor | skipped — floor equalled the balance, nothing above it |
| 3 | undelegate, wait `k=3` quiet blocks, then empty 4.8064 MON | **success** |

Case 1 confirms the floor is real and enforced. Case 3 confirms the de-delegation escape works
exactly as documented.

**The two readings are equivalent.** Enumerating every `(start, end)` pair from 0–30 MON, the
permissive rule (`end >= min(start, 10)`) and the strict rule ("reverts if it decrements *and*
ends below 10") **disagree on zero of 961 cases**. They are the same rule. The apparent
contradiction only appears if you drop the "decrements **and** drops below" qualifier — which
the reserve-balance page states explicitly and which I quoted but then failed to apply.

So `reserveFloor()` was correct all along, and Q3 was never the architectural fork it was
written up as. Worth recording as a caution: two documentation passages saying the same thing in
different words read as a contradiction when one of them is paraphrased.

### What this means for the rescue

| victim start balance | inflow | floor | sweepable | stranded |
|---|---|---|---|---|
| 4.86 MON (this test account) | 500 MON | 4.86 | **500 MON** | 4.86 MON |
| 0 (a drained wallet — the real case) | 500 MON | 0 | **500 MON** | 0 |

The floor only ever strands what was *already* there. **Everything the claim brings in is
sweepable**, which is the case that matters: a compromised wallet has usually been emptied of
liquid MON already, so its floor is near zero.

### Superseded: the earlier partial finding

Script A produced evidence without being designed to. At block **50,823,513**
(tx `0x3aa6a9f3a4a84fa260e879f1c48760321de3a10d1c2bf2d7444ad492ef847371`):

| | |
|---|---|
| account delegated at transaction end | yes (`0xef0100147bc559…`) |
| balance | 4.920652 → 4.915916 MON — **decreased** |
| ended below 10 MON | **yes** |
| transaction status | **success** |

So a delegated account decremented its balance and ended below 10 MON, and the transaction did
**not** revert. **The strict reading — "transactions that would reduce its balance to below
10 MON will unconditionally revert" — does not hold as written.**

This is consistent with the reserve-balance page's sender clause: *"For the sender, the ending
balance may be lower by at most the transaction's gas spend."*

**What this did NOT settle at the time.** It is the sender-pays-gas case only. The sweep is a
*value* transfer out of a delegated account, which the same page treats separately. Script C
case 1 has since settled it — see RESOLVED above.

### The documentation contradicts itself, and the rest still matters

Two statements in the docs cannot both be true for a delegated EOA:

- **Permissive reading** (reserve-balance page): "For a non-sender account, the ending balance
  must not be lower than `min(balance at transaction start, user_reserve_balance)`." With a
  start of 0, the floor is 0 — a full sweep is legal.
- **Strict reading** (EIP-7702 page): "transactions that would reduce its balance to below
  10 MON will **unconditionally** revert", where "dips below" means "decrements **and** drops
  below". Sweeping 1000 MON to 0 both decrements and ends below 10 — so it would revert.

The difference is the whole outcome: **sweep everything, or always strand 10 MON.**
`packages/shared/src/reserve.ts` implements the permissive reading.

**This is settled — the two readings are the same rule** (961/961 agreement, above), and
script:c case 1 measured the enforcement directly. Kept here only as the record of how the
question looked before it was answered; the RESOLVED section is authoritative.

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

## Q27 — Atomic attacker, live: its drain was starved of its nonce and never mined

**Epoch 1071, testnet.** `MODE=atomic ADVERSARY_STRATEGY=react`, equal fee (45 gwei), against our
pre-queued arm. The ~97%-of-mainnet re-delegating sweeper, run for the first time. Verified on
chain.

```
atomic drain tx 0x1195bc54… — NEVER MINED (adversary's waitForTransactionReceipt timed out)
safe   +116.148644 MON  (15.92 loose + 100 position + rewards — full recovery)
sink   +0
victim  10 MON, delegated to our rescue contract, slot claimed
```

### What happened

The attacker fired its atomic drain at block 53504989, from the **victim account**, at the victim's
then-current nonce. But our spray was already running (from 53504951) and its authorization
applications were climbing the victim nonce — the arm log shows it move `210 → 215 → 220 → … → 244`
across the window, ~0.7/block, each `THREAT nonce_advanced` line being one of our own
authorizations applying. By the time the attacker's drain reached a leader, our authorizations had
consumed its nonce, and it was dropped unmined — the same starvation that killed relock at epoch
1053 (Q25), now reproduced against a full atomic drain.

So the Q26 hypothesis held live: **the atomic drain is sent from the victim account, its nonce is
the counter our spray drives, and it was starved.** Two independent confirmations now (relock,
atomic-react).

### The honest limit — this is NOT the conclusive atomic test

Read this before treating the atomic threat as closed. It is not.

- **react reaches only N+1 anyway.** The adversary's own caveat stands: a win here is partly the
  pre-queue edge, not purely the starvation.
- **The attacker was non-adaptive.** It sent ONE drain from the victim account at a single nonce
  and blocked on the receipt. Everything about the loss is contingent on that.
- **A sophisticated atomic attacker mirrors our own design and is NOT obviously starved.** The
  drain does not *have* to be sent from the victim account: the attacker can **sponsor** it from a
  second account (the drain tx consumes the sponsor's nonce, not the victim's) while carrying a
  victim authorization — exactly how our guardian sponsors our rescue. The authorization still
  needs the victim's current nonce, but the attacker can **march their authorizations across a
  nonce range** just as we do, so our bumping no longer strands them. That attacker — sponsored
  drains + a marching victim-authorization window — is the true worst case, and it is **unmeasured.**
  Against it the flip-block auction likely comes down to ordering and fee, where we hold no
  structural edge, only the pre-queue-into-N advantage if they react rather than pre-queue.

**Net:** a real win against the common non-adaptive atomic attacker, and a second live confirmation
of the nonce-starvation edge — but the mirror-design atomic attacker (sponsored + marching auths)
is the last real unknown, and the product claim must not yet assert we beat it.

---

## Q26 — Reverted-drain delegation survival, and why the atomic attacker fights our nonce

Measured before building the atomic prequeue battle test, to remove a variable.

### The fact (measured, definitive)

`test:drain-survival`, tx `0x5f8bac71…`, block 53110422:

```
delegated before:  0xce204ab5…  (our rescue contract)
atomic drain on an empty slot -> REVERTED (NothingToTake)
delegated after:   0x2d8c923d…  (the drainer)
victim nonce:      201 -> 203  (2 consumed)
```

So on Monad, an EIP-7702 authorization **applies before the top-level call and is NOT rolled back
when that call reverts.** Both nonces are consumed — the transaction's (201→202) and the
authorization's (202→203) — even though `drain()` reverted. The delegation designator persists on
the drainer. This matches the spec's ordering (authorizations processed before execution) and is
now confirmed against live chain rather than assumed.

### The consequence: the atomic attacker sends from the victim account, so we starve its nonce

This is the structural point, and it composes with the emergent epoch-1053 observation (Q25) into
something sharper.

Our rescue is sent by the **guardian** (a separate account); only the victim *authorization*
consumes the victim's nonce. The attacker's atomic drain is sent **from the victim account itself**
(they hold the seed), so its *transaction* consumes the victim's nonce — and its self-delegation
authorization consumes one more. Both sides therefore draw from the same counter, the victim's
nonce, and **our spray drives it.** At epoch 1053 our authorization applications climbed it
~0.7/block; any transaction the attacker pre-signed at a fixed victim nonce was stale before it
could land.

That puts the atomic attacker in a bind with no comfortable move:

| attacker's atomic strategy | why it is disadvantaged |
|---|---|
| pre-queue atomic drains at fixed victim nonces | our authorizations bump the victim nonce past them; they go stale and never mine (measured: relock at 1053) |
| react — sign a fresh atomic drain at the current victim nonce at the flip | reacting reaches only block **N+1**; the epoch advances in tx 0 of the flip block, so it cannot land in N while we pre-queue into N |
| re-delegate once early, then spray plain drains | our rescue authorizations re-delegate the victim back to us AND consume its nonce, invalidating the plain drains and undoing the delegation |

**This is a genuine structural edge, not a bid or a latency trick** — it falls out of the attacker
having to spend the victim's nonce while we spend the guardian's, with our authorizations driving
the shared counter. But state it as a **hypothesis still to be confirmed by an atomic battle
test**, not a settled result: an adaptive attacker may find a line not enumerated above, and the
edge is contingent on our spray actually running and consuming nonces at the flip. The honest
product claim does not yet rest on it.

---

## Q25 — Anti-revoke, finally exercised: proven in isolation, and an emergent nonce race

Three battle tests never made the attacker re-delegate, so `window.json`'s reason to exist stayed
untested. The epoch 1053 run was meant to fix that with `relock`, and it produced two results —
one deliberate, one emergent — plus a correction to my own diagnosis.

### The mechanism is proven (isolated test, definitive)

`test:antirevoke` reproduces the anti-revoke question without a flip, in ~1 minute:

```
victim 0xa5d7…86B3: 30 MON, 20 sweepable
[attacker] re-delegating victim to the drainer 0x2D8c923d…
  victim now delegated to: 0x2d8c923d…  (drainer — locked out)
[guardian] sweeping with authorization re-asserting delegation at victim nonce 200
  sweep tx 0x7521d770… -> success in block 53108712
  victim delegated after: 0xce204ab5…  (RE-ASSERTED to rescue contract)
  safe received: 19.9898 MON
PASS
```

The attacker re-delegated the victim to their drainer; our `sweep()` carried one authorization
from `window.json` (victim nonce 200); the authorization was processed before the top-level call,
re-delegating the victim back to our rescue contract; `sweep()` then ran our code and moved 19.99
MON to the safe address. **The destination-locked contract executed after our authorization
re-asserted our delegation over the attacker's re-delegation.** That is the anti-revoke property,
demonstrated directly for the first time. It does not depend on winning any race — it is a
property of the authorization-before-call ordering in EIP-7702.

### The emergent result: our spray starved the attacker's re-delegation of its nonce

In the live epoch 1053 run, `relock` broadcast its re-delegation (tx `0xb8e0d667…`) at the flip —
and it **never mined**. The victim nonce over the window tells the story:

```
victim nonce: 159 @52604939 → 163 @52604949 → 172 @52604962 → 184 @52604980 → 198 @52605000
```

That climb — ~0.7 nonce/block, 159→198 — was **entirely our guardian's authorization
applications**: every rescue attempt that executed applied a victim authorization from the window,
and applying an authorization increments the authority's nonce. `relock` signed its re-delegation
at nonce 159; by the time it reached a leader our spray had already consumed 159 and beyond, so the
attacker's transaction was stale and was dropped. Its `waitForTransactionReceipt` timed out because
it never landed.

So under a live spray, a single flip-time re-delegation from the attacker can be **starved of its
nonce by our own authorization traffic.** State it precisely and do not oversell it: this is one
observation against a non-adaptive single-shot attacker. An attacker who re-delegates *before* our
spray starts (while the nonce is stable), or sprays re-delegations across many nonces, is not
starved — and the isolated test above is exactly why that attacker still loses: whenever their
re-delegation *does* land, our next authorization re-asserts over it. The two results compose: land
or not, the position stays ours.

### Correction: my `relock` diagnosis was wrong twice

I first blamed an unguarded poll loop (a real weakness, now fixed, but not the cause), then took
the "0 victim txs on-chain" reading as "relock never fired". The log and the missing receipt show
what actually happened: relock *did* broadcast, the tx lost the nonce race and never mined, and
`waitForTransactionReceipt` timed out. The lesson for the harness: to test anti-revoke under a live
spray, `relock` must re-delegate *before* `sprayStart`, while the victim nonce is still stable —
firing at the flip puts it into a nonce race it structurally loses. Fixed accordingly.

---

## Q24 — The first contested win, reconstructed from receipts — and what it does NOT prove

**Epoch 1046, testnet, validator 40 slot 0, 100 MON.** Equal fee (45 gwei both sides; guardian
45000000015 wei vs attacker 45000000000 — a 15-wei tie-break, effectively equal), equal strategy
(both pre-queued one attempt per block), gas sized correctly, all pre-arm checks passed,
`window.json` loaded. Every number below was re-read live and verified against decoded receipts.

Result: **safe +500.481907 MON, attacker sink +0.** But *how* matters more than *that*, and the
forensic pass corrected an overclaim.

### Block by block

| block | epoch | request(40,slot0) | safe (MON) | event |
|---|---|---|---|---|
| 52254941 | 1045 (delay) | 100, full | 399.440631 | baseline |
| **52254942** | 1045 (delay) | **still 100** | **799.407916** | **premature loose sweep** |
| 52254943–57 | 1045 (delay) | still 100 | 799.407916 | spray continues (bar unmet) |
| **52254958** | **1046** | **0, claimed** | **899.922538** | **flip + position claim (win)** |
| 52254962–55008 | 1046 | 0 | 899.922538 | 46 attacker withdraws, **all revert** |

- **Loose sweep** — tx `0xb5f9ae2e…`, guardian nonce 77, block 52254942. `WithdrawFailed("withdrawal
  not ready")` + `Rescued(399.96728503, validatorCount 0)`. The position was not yet mature; only
  the victim's loose balance moved, sweeping it to the 10 MON floor. Request stayed at 100.
- **Win** — tx `0xe4dbb046…`, guardian nonce 90, block 52254958 (epoch flips 1045→1046 in this
  block's tx 0). `Withdraw(100.020127)` + `ClaimRewards(0.494495)` + `Rescued(100.514622,
  validatorCount 1)`. Request cleared to 0.

### What it PROVES

- **The epoch-1040 completion-bar fix works live, in a contested race — this is the headline.**
  `doneThreshold = prematureSweep + 90% of position = 399.967 + 90 = 489.967`. The premature sweep
  delivered 399.967, which is **below** the bar, so `isDone()` stayed false and the spray **kept
  going** for 16 blocks to claim the position at the flip. Under the old 1-wei bar, the 399.967
  sweep would have read as "done" and conceded the 100 MON — the exact epoch-1040 defect, now
  demonstrably closed against a live opponent. `spray()` gates on `isDone()` (cumulative balance vs
  bar), not on any single receipt status, so nonce 77's `success` could not stop the run.
- **Won on mechanism, not money.** Equal fee, equal strategy, no bidding edge used. Full recovery
  of everything above the floor (500.48 = 399.97 loose + 100.51 position+rewards).

### What it does NOT prove — read this

- **The destination lock is NOT why the attacker got zero.** This corrects a claim made in the
  moment. The attacker's zero came from **losing the race**, not the lock. All 46 of their mined
  withdraws (nonces 108–153, blocks 52254962–52255008 — every one *after* our win at 52254958)
  reverted on the slot we had already emptied: 0 successes, 0 addressed to the sink. **No attacker
  withdraw ever succeeded, so no funds ever landed in the victim EOA for the lock to redirect** —
  the lock was never exercised on the attacker's path this run. It held on *our* value-moving txs
  as a construction property (both `Rescued` events paid the safe address, no recipient argument
  exists), but do not credit it for the attacker's zero. Speed did that.
- **The ~400 MON loose balance was saved by speed, not by anything defensible.** Liquid MON
  remains indefensible against a seed holder in general; here we simply reached it first. Do not
  generalise this run into "we protect liquid balance".
- **`window.json`'s anti-revoke path was carried but NOT exercised.** The naive attacker never
  re-delegated, so our delegation was never challenged and the marching authorizations
  (nonces 91..157) had nothing to undo. The re-delegating (atomic) attacker is still the open
  question — see Q23.
- **The 4-block margin at the flip is unexplained and may be an artifact.** We landed in 52254958,
  the attacker's earliest mined withdraw at 52254962. Both pre-queued at equal fee, so the gap is
  not a fee or strategy edge; it is likely spray-timing/latency against the shared local node and
  should not be read as a structural advantage.

**Net:** one honest, verified win over an equal-fee equal-strategy *naive* attacker, and the
completion-bar fix earning its place in a real race. The auction proper (both in the flip block)
and the atomic attacker remain unmeasured.

---

## Q23 — Building the atomic adversary, and a viem nonce trap that would have faked a win

The atomic re-delegating sweeper is the common attacker (Q21: ~97% of mainnet 7702 delegations).
`AdversaryDrainer.sol` is that opponent — a mirror of the rescue path with an immutable `SINK`
instead of `SAFE_ADDRESS`, so it is a fair adversary and cannot become a weapon (no recipient
parameter; only reachable by delegating an account whose key you already hold). `MODE=atomic`
self-delegates the victim to it and calls `drain()` in one type-0x04 transaction, leaving no
block in which the withdrawn MON sits on the EOA for our sweep. Against this our advantage is not
the two-transaction gap — it is the authorization window undoing their re-delegation inside our
own rescue.

The commit was reviewed line by line (once by hand, once by a 20-agent adversarial workflow) and
six real issues surfaced, all now fixed. Two are worth keeping.

### The viem `executor: 'self'` nonce trap — latest vs pending

A self-sponsored 7702 transaction must carry an authorization whose nonce is `txNonce + 1`: the
transaction consumes the sender's current nonce, *then* the authorization is validated. The first
cut trusted viem's `executor: 'self'` to set this. It does not set it against your transaction's
nonce. Verified against installed viem 2.55.10 (`_cjs/actions/wallet/prepareAuthorization.js`):

- the transaction nonce came from `getTransactionCount` at **`blockTag: 'latest'`**;
- `prepareAuthorization` fills the authorization nonce from its **own independent**
  `getTransactionCount` at **`blockTag: 'pending'`**, then `+1` for `executor: 'self'`. It never
  reads the `txNonce` you pass to `signTransaction`.

So `authNonce == txNonce + 1` holds **only when `pending == latest`**. Any single unconfirmed
transaction from the account at fire time makes `pending = latest + 1`; the transaction consumes
`latest` (account → `latest+1`), the authorization carries `latest+2 ≠ latest+1`, and per
EIP-7702 the tuple is **invalid and silently skipped while the transaction still returns
`status: success`.** The EOA is never delegated to the drainer, `drain()` never runs, nothing
moves — and the harness would have written `drainStatus: success`, recording a fired-and-took-
nothing adversary as if it had run. That is the epoch-1035 class of unearned result, in the
opponent this time. Fixed by passing the authorization nonce explicitly as `txNonce + 1`, derived
from the same `latest` read as the transaction.

The lesson generalises past this repo: **do not let a signing helper fetch its own nonce when a
sibling call fetches one too.** Read once, derive both.

### A react-mode adversary can only ever demonstrate a loss

`MODE=atomic` with the default `react` strategy fires on detection, which reaches only block
**N+1** — the epoch advances in tx 0 of the flip block, so a reaction cannot land in N, while
`arm` pre-queues into N. So a **win** in atomic-react is not evidence we beat an atomic attacker;
it is the one-block pre-queue edge the react adversary structurally lacks. Only a **loss** is
meaningful there. The console says this, and — because a stored artifact outlives the console and
gets over-read — the artifact now carries `conclusive: false` and a `note` whenever
`strategy === 'react'`, so a later reader cannot mark the conclusive test done on a drain revert
that proves nothing. The conclusive atomic test needs `ADVERSARY_STRATEGY=prequeue`, still gated
until the reverted-drain delegation-survival question is measured on-chain.

### The other four, briefly (all fixed)

- Atomic artifact recorded the sink's **absolute** balance; `ATTACKER_SINK` accumulates across
  runs (98 MON since epoch 1040), so it now records the **delta**.
- `deploy:drainer` did not rebuild the contract artifact first — the stale-`dist` failure class
  that has already cost a rescue. It now runs `contracts/build.mjs` before deploying. (`deploy:contract`
  for MonRescue has the same latent gap and should get the same treatment.)
- `deploy-drainer` logged a `SINK` mismatch but exited 0 and wrote a success artifact, unlike
  `deploy.ts`. It now throws.
- A solc shadow warning (`bool ok` declared twice) that could mask a future real warning —
  renamed.

---

## Q22 — Monad caps the EIP-7702 authorization list, and does not say so

Measured 2026-08-09 on testnet while arming for epoch 1046.

| tuples in the list | result |
|---|---|
| 6 | **rejected** — `EIP7702 authorization list length limit exceeded` |
| 4 | **accepted** — tx `0x91d2a808…`, block 52,172,718 |

So the cap is 4 or 5; 5 is untested. The rejection happens at the RPC, before the transaction
exists, so probing costs nothing.

**It is not in the specification and not in the documentation.** EIP-7702 places no limit on the
list. Monad's own EIP-7702 page documents the 10 MON balance rule and the `CREATE`/`CREATE2`
restriction and says nothing about list length. It was found by a transaction being refused.

### Why this did not break the anti-revoke defence

Because the ranges already march. The authorization list carried by each spray attempt starts at
`victimNonce + i`, so a 64-attempt spray at 4 tuples each covers nonces **91..157** — 67
consecutive nonces from a 256-nonce window. The attacker at epoch 1040 burned 61 nonces in a
single flip window, so that is the coverage that matters.

Had the list stayed fixed — every attempt re-asserting at the same 4 nonces, as it did until the
day before — this cap would have reduced the defence to four specific nonces and any attacker
spraying through the window would have walked past it. The marching design was written for a
different reason and happens to absorb this one.

**Consequence for sizing:** `AUTHS_PER_ATTEMPT` cannot be raised to buy coverage. Coverage comes
from attempt count times list length, and the second factor is capped by the chain. More
coverage means more attempts, which costs gas per attempt, which is bounded by the inflight cap.
Worth remembering before assuming the window can simply be widened.

---

## Q21 — The ecosystem says our "sophisticated" attacker is the ordinary one

Read after three battle tests, from public reporting rather than our own chain work.

**Within four weeks of Pectra, ~97% of EIP-7702 delegations on Ethereum mainnet pointed at
sweeper contracts** — Wintermute's "CrimeEnjoyor", all of them the same copy-pasted bytecode,
verified by reversing it to Solidity. Scam Sniffer recorded a single 7702 transaction costing one
victim >$150,000; Inferno Drainer took >$9M from 30,000+ wallets in six months.

We have been treating "the attacker re-delegates the EOA to their own contract" as the
sophisticated case, to be tested after the naive one. **It is the dominant case in the wild.** A
compromised wallet arriving at our intake is more likely than not to be *already delegated to
hostile code*.

### SETTLED — the payout is a raw credit, and the advantage holds

Measured 2026-08-08 with `eth_call` + state override, so nothing was broadcast. The probe
installs `0x60006000fd` (PUSH1 0, PUSH1 0, REVERT) as the victim's code — reverts on any
invocation — and asks whether the precompile's payout trips it.

| test | result |
|---|---|
| plain value transfer to the victim, no override | OK |
| plain value transfer to the victim, **revert-code installed** | **REVERT** |
| `claimRewards(40)` from the victim, delegated normally | OK |
| `claimRewards(40)` from the victim, **revert-code installed** | **OK** |

The second row is the positive control and it is what makes the fourth meaningful: the override
*is* honoured, and a value-bearing CALL to an address with code *does* execute it. The precompile
paying the same account does not.

**So the payout is a raw balance credit. No recipient code runs.** Consequences:

- An attacker with a sweeper delegated does **not** get an atomic drain. Their `withdraw()`
  credits the EOA without triggering their own fallback, so they still need a second transaction
  — and that gap is what `sweep()` takes. The advantage survives contact with the 97% pattern.
- `MonRescue.receive()` is **not** required for the withdrawal payout, contrary to its comment.
  Keep it for plain transfers; the stated reason was wrong.

**Limits, stated:** measured via `claimRewards`, not `withdraw`, and via `eth_call` rather than a
broadcast transaction. Both are documented as paying `msg.sender` by the same mechanism, but
close it against `withdraw()` on the next matured slot before treating it as final.

### The assumption as it stood before that measurement

`MonRescue.sol` carries `receive() external payable {}` with the comment *"Required so the
account can receive the precompile's withdrawal payout."* That comment asserts the staking
precompile pays `msg.sender` via a **CALL**, which executes the recipient's code. It has never
been verified — Q1 passed with `receive()` present, so the alternative was never exercised.

The two possibilities are not close:

| if the payout is… | consequence |
|---|---|
| a **CALL** (runs recipient code) | an attacker with a sweeper delegated drains **atomically**: their `withdraw()` triggers their own fallback and forwards the funds in the same transaction. The two-transaction gap that `sweep()` exists to exploit **does not exist** against the 97% pattern |
| a **raw balance credit** | no code runs on payout, the attacker still needs a second transaction, and our advantage holds |

Everything the product claims against the *common* attacker rests on which of these is true, and
we do not know. It is cheap to settle: delegate the victim to a contract whose `receive()`
reverts, then call `withdraw()`. Revert means CALL; success means raw credit.

**Do not claim the two-transaction advantage until this is measured.**

### What else the comparison turned up

`codeesura/eip7702-asset-rescuer` is the closest public prior art. It is a two-party design — the
compromised wallet signs a batch payload offline, a sponsor broadcasts and pays gas — with
`Tracker.sol` for anti-replay. Two differences worth stating:

- **It has no destination lock.** The payload names its own recipients, so whoever holds the
  signed payload chooses where the funds go. Ours cannot: `SAFE_ADDRESS` is immutable and no
  function takes a recipient. For a one-off manual rescue their model is fine; for a *service*
  holding many users' authorizations it is the difference between "a leak is nonce griefing" and
  "a leak is theft".
- **It documents no race defence at all** — no gas strategy, no pre-queuing, no private
  orderflow. It is built for rescuing ERC20s and NFTs from a sweeper watching for gas, not for
  winning a scheduled unlock against a funded adversary.

So the racing machinery is ours to get right; there is no prior art to copy for it.

---

## Q20 — The second battle test: we lost the position by declaring victory over dust

**Epoch 1040, testnet.** Both sides pre-queued one attempt per block across the same 60-block
window, both bidding **70 gwei**, gas now sized correctly at 438,750. The equal-fee, equal-strategy
test — the hard half of the table, run for the first time.

### The sequence

| block | event |
|---|---|
| 51,954,952 | **our rescue succeeded** — but the epoch had not flipped. `withdraw()` failed, `_sweep()` moved the victim's loose 49.56 MON to the safe address. Receipt: 2 logs, `WithdrawFailed` then `Rescued` |
| — | `isDone()` saw the safe balance rise, reported the rescue complete. Spray stopped at **1 of 62** attempts. `arm` printed "rescue landed" and **exited** |
| ~51,954,99x | the attacker's queued withdraw landed after the flip and claimed the **100 MON** into the EOA, unopposed |
| 51,955,003 | their fallback withdraw reverted — their own earlier attempt had already emptied the slot |
| 51,955,005 | **their transfer succeeded: 98.24 MON** to the attacker's sink |

Final: safe `+49.56`, attacker `+98.24`, victim left at the 9.996 MON floor.

### Why: the success condition could not tell dust from the position

`makeSafeBalanceChecker(..., 1n)` — **any** increase in the safe address balance counted as
success.

A pre-maturity attempt is not a no-op. `withdraw()` fails, but `_sweep()` still moves everything
above the reserve floor, and that is correct: the money goes somewhere only the user controls.
It is also, at a 1-wei threshold, indistinguishable from having claimed the position.

So the first premature attempt swept 49.56 MON of loose balance, the run declared itself
finished **ten blocks before the epoch flipped**, and stopped spraying. Everything downstream was
correct and irrelevant — the gas fix worked, the window was covered, the fee was matched, and
none of it mattered because the process had already exited.

### The fix

The threshold is now the **position**, not any movement: `totalAmount × 0.9`. A full rescue
delivers roughly `victim balance + totalAmount − floor`; a premature dust sweep delivers
`balance − floor`, smaller by exactly the position. Two other paths made the same mistake and
were treating a successful *receipt* as a completed rescue — the single-attempt path and the
backstop — and both now ask `isDone()` instead. `finish()` exits non-zero on a partial recovery,
because a zero exit code is what a supervisor reads.

### What this run does establish

- The gas fix works. Our transaction executed and swept successfully at 438,750 where every
  attempt at epoch 1035 died with `out of gas`.
- The broadcast gate works: `holding broadcast until block 51954940` appears in the log, and no
  gas was spent on the 40 blocks before the flip was possible.
- The threat watcher works: it reported the attacker's nonce advancing 23 → 24 → 30 and the
  balance falling, live, while they sprayed.
- A competent attacker who sizes their transfer against the reserve floor **does** get the money
  out. The epoch 1035 "win" was their arithmetic error, exactly as suspected.

**Still unmeasured: who wins the flip block at an equal fee.** Three battle tests, three
different defects on our side, and the auction has yet to decide anything.

---

## Q19 — The first battle test: we lost, and not for any reason we were testing

**Epoch 1035, testnet.** Both sides pre-signed, both bidding **75 gwei** — an equal-fee test.
Adversary in `naive` mode, polling at 50ms, reacting. Us pre-queued across the window at one
attempt per block, 100% coverage.

### What happened

| | |
|---|---|
| epoch flipped | block 51,704,945 |
| attacker `withdraw()` | **success**, block 51,704,947 |
| attacker transfer to their sink | **reverted**, block 51,704,949 |
| our 63 spray attempts | all mined, **all reverted** |
| our backstop | **reverted**, block 51,705,033 |
| safe address received | **0 MON** |

### Why we lost: the gas cap was larger than the gas limit

`rescue()` calls `withdraw()` first, and the staking precompile **consumes everything forwarded
to it** on failure. The contract capped that forward at `WITHDRAW_GAS_CAP = 400,000` — but the
transaction's own limit was **350,000**, set by `GAS_LIMIT` in `.env`.

A cap only caps if it is smaller than the gas the transaction actually holds. EIP-150 forwarded
63/64 of what remained (~344,000), the precompile ate all of it, and `_sweep()` never ran. The
protection the contract documents at length was **not in effect at any point**.

Confirmed by simulation against the post-race state:

```
rescue(claimRewards=true)   gas   350,000  -> REVERT: out of gas
rescue(claimRewards=true)   gas 1,000,000  -> OK
rescue(claimRewards=false)  gas   350,000  -> REVERT: out of gas
sweep()                     gas   120,000  -> OK
```

So the race was never run. Fee, timing, pre-queuing, window coverage — none of it was tested,
because every transaction we sent was incapable of succeeding before it was broadcast.

### The receipt cannot tell you this, and that matters

The first diagnosis reached for `gasUsed` and found 350,000/350,000 on every failed attempt —
apparently conclusive. It is not: **Monad charges the limit rather than the usage**, so
`gasUsed` in a receipt always equals the limit. The attacker's *successful* withdraw reports
200,000/200,000 by the same rule.

`gasUsed` therefore carries no information about consumption on Monad, and an out-of-gas revert
is indistinguishable from any other revert — and from losing a race — by receipt alone.
`eth_call` at varying limits is what separates them. Worth remembering: the obvious field is a
decoy here.

### What the delegation did while we were failing

The attacker's own transfer reverted. Their EOA held 124.97 MON, is delegated to our
destination-locked contract, and the reserve rule caps what a delegated account may send at
`balance − min(balance, 10 MON)` = 114.97 MON. They tried to send 124.9 and tripped it.

So the 7702 delegation held the position while our entire rescue path was inoperative. **Do not
sell this as a defence** — sending the correct amount would have worked, and a second attempt
costs them one block. But it is why this run cost nothing.

`sweep()` then recovered **114.97 MON** in one call, tx `0xf40e1d85…`, block 51,721,152, leaving
the victim at exactly the 10 MON floor.

### Three defects, all silent

1. **`WITHDRAW_GAS_CAP` (400,000) > transaction limit (350,000).** Now 100,000 for `withdraw`
   and 200,000 for `claimRewards`, both just above their measured successful costs (68,675 and
   155,375). Requires **redeployment** — the caps live in the contract.
2. **`estimateRescueGas()` sized the success case.** A failing call costs its full cap, not its
   successful cost, so the limit must cover every call failing. One position with rewards goes
   from ~280,000 to **428,750**.
3. **`GAS_LIMIT` in `.env` silently overrode the estimate.** `arm` now refuses to start when the
   override is below the computed requirement, rather than warning.

And a fourth, in the CLI: `positionsGone()` checked only whether the withdrawal slots were
empty, so it reported "the funds left without us" while 114.97 MON sat on the EOA. An empty slot
plus a live balance is not a loss — it is precisely what `sweep()` is for. It now checks both.

### Measured floor, and what it proves

Binary search against the redeployed contract, `eth_call` at descending limits, with slot 0 empty
so `withdraw()` fails — the exact shape of the epoch 1035 failure:

| case | minimum working gas limit |
|---|---|
| validator 40, empty slot, `claimRewards=true` | **145,543** |
| validator 40, empty slot, `claimRewards=false` | **145,543** |
| validator 1, no delegation at all, `claimRewards=true` | **145,543** |

Identical in all three, which is itself the confirmation. `rescue()` does `continue` when a
withdraw fails, so `claimRewards` is never reached and the flag cannot matter. And
145,543 − 100,000 (the withdraw cap, consumed in full) = **45,543** of fixed overhead.

So the failed call does consume everything forwarded to it, exactly as the docs say — the old
400,000 cap simply meant "everything" was the whole transaction.

### Checked against the documentation, at last

The gas model had been assembled from measurement and one remembered sentence. Reading
`docs.monad.xyz` properly confirms all of it and adds three things worth having:

| claim | source | verdict |
|---|---|---|
| `gas_paid = gas_limit × price_per_gas` | gas-pricing | confirmed |
| *"calls with invalid arguments consume all gas"* | staking/api | confirmed, and it is the whole bug |
| documented costs: withdraw 68,675, claimRewards 155,375, undelegate 147,750, delegate 260,850 | staking/api | match our traces exactly |
| sender may dip by `gas_price × gas_limit` | reserve-balance | confirmed, now with the formula |
| inflight budget `min(user_reserve_balance, lagged balance)` over `k` blocks | reserve-balance | confirmed |
| minimum base fee 100 MON-gwei | gas-pricing | confirmed |
| ordering by descending total gas price | gas-pricing | confirmed |

**New, and it changes an estimate.** Monad prices **cold account access at 10,100 gas against
Ethereum's 2,600**, and cold storage at 8,100 against 2,100; warm access is unchanged. Memory
expansion is linear (`w/2`) rather than quadratic. The sweep's call to `SAFE_ADDRESS` is always
cold, so the non-call overhead is ~45.5k rather than the ~37k an Ethereum-priced breakdown
predicts — which is precisely the gap the binary search found. `estimateRescueGas` now carries
the measured number.

**New, and it is a trap we happen to avoid.** *"If an account attempts to delegate to the staking
precompile using EIP-7702, all calls to it will revert."* We delegate to MonRescue, never to
`0x…1000`, so this does not bite — but a design that tried to shortcut through a direct
delegation would brick the account silently.

### The pattern, again

This is the fifth time a number chosen for frugality sat on a path where being short loses
everything: the 350k limit (twice now), the fee multiplier, the pre-queue default, the 3-block
broadcast cadence. And it is the sixth silent failure — mined, charged in full, reverted, with
a receipt that looks exactly like losing an honest race.

**The battle test is still unrun.** Nothing about the contest was measured.

---

## Q18 — Why spray at all? Mostly, you should not

The spray was designed when detection cost **~116ms** over remote RPC — roughly a third of a
block — so "we will notice too late to react" was a real problem and pre-queuing was the answer.

Beside a local node detection is **~8ms**, under 4% of a block. The premise is gone.

### What pre-queuing still buys: exactly one block

The epoch advances in **transaction 0** of the flip block (Q12). So a transaction already
sitting in a leader's mempool is included in *that same block*, after the syscall, and succeeds.
Reacting to the flip — however fast — can only reach block **N+1**.

That one block is decisive in exactly one of three cases:

| attacker | us | outcome |
|---|---|---|
| reacts | reacts | both at N+1 — **fee decides**, spray bought nothing |
| reacts | pre-queued | we are in N, they are in N+1 — **we win outright** |
| pre-queues | pre-queues | both in N — **fee decides**, spray bought nothing |

### What it costs

Every premature attempt reverts (`withdraw` not yet matured) and is charged its **full gas
limit**, because Monad charges the limit and the precompile consumes all gas on failure. A
queued transaction is included within about a block, so covering the ~40-block flip uncertainty
means roughly one attempt per block:

| attempts | burnt on premature reverts |
|---|---|
| 5 | 0.24 MON |
| 20 | 0.95 MON |
| 40 | 1.90 MON |

### Consequence — pre-queue by default anyway

The costing above argues for reacting, and that argument is wrong, because it optimises the
wrong side of an asymmetric loss:

- pre-queuing costs ~2 MON and can only ever **win** a block
- reacting saves ~2 MON and can **lose the entire position**

We also cannot know in advance whether a rescue is contested, and by the time we could know it
is already decided. A rescue exists precisely because someone hostile holds the key; assuming
they are passive is the wrong default.

So `window` is the default whenever there is a flip to wait for. `off` applies only when the
position is **already mature** — there is no flip to arrive ahead of, so a single well-priced
attempt is exactly right and queueing would burn gas for nothing.

**A pattern worth naming.** This is the third time in this project that a default was set for
frugality on a path where being short is fatal and being long merely costs money: the 350k gas
limit that lost an entire attempt, the fee multiplier that scaled a constant, and this. The
operator has said plainly that cost is not the constraint. Defaults should reflect that.

The earlier framing — "the fastest method is to not detect at all" — was right about the
mechanism and wrong about the economics once a local node removed the detection cost. It bought
one block for a price that only makes sense when someone is actually racing.

### The ladder was bidding a random number at the decisive block — fixed

The cubic ladder escalated by *attempt index*. In `window` mode that is not "cheap when
uncontested"; it is a lottery. **We do not know which attempt will be the one in the leader's
mempool when the flip block is built** — any of them can be — so a ramp prices most of the
candidates to lose and reserves the winning prices for rungs that only arrive if the flip lands
late.

Computed against the measured mainnet distribution (base 100 gwei, p90 78, max 1,482), 30
attempts on a 330k-gas rescue with a 5 MON budget:

```
old, cubic across all 30 — tip at the decisive block, by where the flip landed:
  780, 780, 780, 785, 797, 821, 861, 919, 1002, 1112, 1253, 1430,
  1644, 1903, 2208, 2563, 2973, 3443, 3973, 4571, 5239, 5980 gwei
```

An **8x spread on the one number that decides the race**, selected by chance. "We won at an
equal fee" is unmeasurable under that, because there is no single fee to compare.

Now: every window attempt is priced identically, and escalation starts only after the window
closes — where `latestStartBlockFor` guarantees the epoch has flipped, so a still-failing attempt
is the first real evidence of a contest rather than a counter running.

```
new: 22 x 780 gwei = 6.39 MON (window, flat)
     then 780 -> 821 -> 1112 -> 1903 -> 3443 -> 5980 -> 9766 -> 15051 gwei (escalation)
     19.48 MON worst case if every rung fires
```

The window fee anchors on the **p90 (×10)**, not the maximum. The max is a single outlier out of
69 transactions; paying 10x it on every one of ~60 window attempts would cost ~98 MON to cover a
window that is usually uncontested. The outlier is the right anchor for the escalation rungs,
where there is actual evidence someone is racing.

### Two more things that fell out of costing it properly

**Broadcasting started 62 blocks before the flip could physically happen.** `EARLIEST_DELAY_BLOCKS`
is 4,900, deliberately pessimistic because watching early is nearly free. Broadcasting early is
not: every attempt before the smallest possible delay (4,962 measured) is a guaranteed revert
charged its full gas limit, and it consumes a nonce from a finite ladder. Broadcasting now starts
at `SPRAY_START_DELAY_BLOCKS` = 4,940 — 22 blocks of margin against a flip earlier than anything
observed, without the 40 blocks of certain waste. Polling still starts at 4,900. Watch
pessimistically, spend optimistically.

**One attempt every 3 blocks covered a third of the window.** A broadcast sits in the mempool for
about one block before inclusion, so a cadence of 3 leaves two blocks in three with nothing of
ours queued — and if the flip lands on one of those, we are reacting after all and reach N+1.
That is the spray's entire cost for a third of its benefit, and it is the fourth appearance of the
same frugal default. Now 1 block per attempt, and `arm` prints the covered percentage and warns
explicitly when a cap leaves part of the window bare, so a silent truncation cannot read as full
coverage.

### The back-off that would have stranded the whole ladder

Found by reading, then confirmed by executing both versions side by side against a dead endpoint.

`spray()` protected Monad's per-account inflight gas cap by backing off when too many attempts
were in flight. It did so with `continue` inside a `for…of`, which **advances the iterator** — so
hitting the cap did not delay an attempt, it **skipped** it. With `maxInFlight = 1` and eight
queued attempts:

```
old impl tried: 100, 102, 104, 106
skipped       : 101, 103, 105, 107
```

The attempts carry **consecutive nonces**, and a transaction behind a nonce gap cannot execute at
all. Skipping nonce 101 therefore does not cost one attempt — it strands 102 and everything after
it, permanently. **The first back-off silently disabled the entire remaining ladder**, and the
mechanism meant to protect the flip window was the thing that would have lost it.

It would not have looked like a failure. Every skipped attempt produces no log line, and the
surviving attempts broadcast normally and are accepted by the RPC; they simply never execute.
The visible symptom is a spray that "sent" attempts and landed nothing — indistinguishable from
losing the auction.

Fixed by looping on an index that only advances on an actual broadcast, so back-off delays and
never discards. Inflight is now counted as sends within the last 3 blocks — the window the chain
itself uses — rather than a counter that only decremented when backing off and so drifted upward
the longer the spray ran, throttling hardest at the end.

Verified after the fix: all eight nonces tried exactly once, in order, no gaps.

**This is the fourth silent-environment failure, and the first found before it cost anything.**
The others announced themselves only as an unexplained loss. Reading the hot path adversarially —
"what does this do when the guard fires?" — is worth more than another test of the happy path.

---

## Q17 — What a gas war actually costs, and the two delegation states

### Bidding: the multiplier was meaningless, the budget is not

`PRIORITY_FEE_MULTIPLIER` multiplied whatever `estimateFeesPerGas` returned — and Monad's
`eth_maxPriorityFeePerGas` is a **hardcoded 2 gwei**, not a live recommendation. So "20x" scaled
a constant carrying no information about competition. It was a number that felt like a decision
and wasn't one.

Sampling real transactions instead, on **mainnet** across 69 transactions in 5 blocks:

| | |
|---|---|
| base fee | **100 gwei — pinned at the documented floor**, the chain is not congested |
| median tip | 2 gwei (i.e. most senders take the hardcoded default) |
| p90 tip | 78 gwei |
| **highest tip observed** | **1,482 gwei** |

So beating the median is free and beating the top bidder is not — and an attacker racing us is a
top bidder by construction. The spread between p50 and max is **700x**, which is the whole
question compressed into one number.

Fees are now expressed as **MON per attempt**, which is what the operator actually decides.
`planFee` samples live bids, sits `FEE_OVERTOP` (default 10x) above the highest one, and caps
the result by `MAX_SPEND_PER_ATTEMPT_MON`. At 5 MON against a 330k-gas rescue that bids ~14,800
gwei — ten times the top observed bid — for about 4.9 MON.

Against a *quiet* chain this overbids for free. Against a contested one it spends exactly what
was authorised and no more. Both are the intended behaviour, and neither requires guessing a
multiplier.

### The two delegation states are a real distinction, and I had it wrong

An earlier note framed this as "does our authorization exist yet". That is a different question.
The distinction that matters on-chain is:

| | can use the emptying exception | can go below 10 MON |
|---|---|---|
| **not 7702-delegated at all** | yes, after `k=3` quiet blocks | yes |
| **delegated to anything** (ours or an attacker's) | **no** | no |

**Correction, from reading the docs properly (2026-08-08).** An earlier version of this section
said the reserve rule "only binds delegated accounts". It does not. The docs are explicit that it
is universal — *"all EOAs must have enough MON in their account to pay for gas for any transaction
included in the blockchain"* — and that what delegation removes is the **escape**:
*"A transaction is an 'emptying transaction' iff the sender is undelegated"*, and
*"Delegated EOAs cannot use the emptying exception described above."*

The table above is still right; the reason underneath it was wrong. Delegating a wallet does not
*impose* the floor — the floor was always there. It **closes the only door out of it**. Our sweep
maths is unaffected — the floor is `min(balance at start, 10 MON)` and we take everything above
it either way — but the user loses the ability to empty their own pre-existing balance while the
delegation stands. Reversible by undelegating and waiting 3 quiet blocks, which is exactly what
Script C measured.

**The sharper form of that cost, learned by hitting it.** The floor binds the *sender* too — the
sender clause only allows the ending balance to dip by the gas spend, so the most value a
delegated account can send is `balance - min(balance, 10 MON)`. For any delegated account holding
**under 10 MON that is exactly zero**: it can pay gas and nothing else. A `delegate` of 100 MON
from the 5.04 MON victim account was included and reverted for this reason, and the same is true
of an ordinary transfer of any size.

Consequences worth carrying:

- A protected user under 10 MON cannot move liquid MON at all until they revoke. That is a real
  usability cost of intake, larger than "10 MON stranded" suggests, and the UI must say so.
- It is also a small *defensive* property: while our delegation stands, a seed-holding attacker
  cannot drain the account's liquid balance either — they hit the same floor. It does not
  protect anything above 10 MON, so it is not a feature to sell, but it is not nothing.
- Test scripts that spend from the victim account must check the floor locally. `setup-stake`'s
  `delegate` branch now does; anything new that sends value should too.

Worth stating because it is a cost we impose, small but real, and it is not obvious from the
outside that accepting protection changes what your own wallet can do.

---

## Q16 — Real gas, and why the attacker chooses our gas bill

The explorer's internal trace of the successful rescue gives measured numbers rather than
documented ones:

```
withdraw #1   given 320,771   used 68,675
withdraw #2   given 252,149   used 68,675
withdraw #3   given 183,528   used 68,675
sweep -> safe given  98,803   used      0
```

`withdraw` costs **exactly** the documented 68,675. The sweep to a plain EOA costs
essentially nothing. Total consumption was ~251,200 against a 350,000 limit — so the successful
run had real headroom, and `estimateRescueGas` has been recalibrated against this instead of
guessed overheads.

**This also fully explains both runs.** The first passed `claimRewardsToo = true`, needing
`206,025 + 3 x 155,375 = 672,150`; the second passed `false`, needing ~251,200. Same 350,000
limit, opposite outcomes. Nothing was flaky.

### The number of slots is the attacker's choice, not ours

Each withdrawal request needs its own `withdraw()` call. Three slots cost 206,025 where one
would have cost 68,675 — the split was ours here, but **in a real compromise the attacker
decides how many `undelegate` calls to make**, and therefore sets our gas bill:

| slots | gas | cost per attempt at 20x |
|---|---|---|
| 1 | ~129k | 0.26 MON |
| 3 | ~266k | 0.53 MON |
| 10 | ~747k | 1.49 MON |
| 50 | ~3.5M | 6.99 MON |
| 256 (the maximum) | ~17.6M | 35.28 MON |

At the 256-slot maximum a single attempt costs ~35 MON and still fits inside the 30M
per-transaction limit — but it collides with the inflight budget of `min(10 MON, balance)`,
which means **a maximally split position allows fewer than one inflight attempt at a 20x
multiplier**. The spray collapses to a single shot.

This is a cheaper griefing vector than the `withdrawId` exhaustion considered in Q10, and it
does not require exhausting anything: an attacker who splits into 50 slots while unstaking has
multiplied our per-attempt cost 13x and cut our shots proportionally, for the price of 50
ordinary transactions.

**Not yet mitigated.** The obvious response is to split the rescue across several transactions
— each claiming a subset of slots — so that no single one is huge and the inflight budget
buys more attempts. That trades atomicity per transaction for parallelism across them, which
is the right trade only because each partial sweep still lands at the destination-locked
address. Worth building before mainnet.

---

## Q15 — The first firing: it fired, and ran out of gas

2026-08-06, epoch 1029, against the three positions matured at 1019.

**The mechanism worked.** Positions were discovered from the `Undelegate` events with no manual
input, the reserve floor computed correctly (5.04 MON stranded, 500 MON sweepable), 31 attempts
were pre-signed in **118ms**, and the spray broadcast 17 of them at 69–197ms each. The hot path
did exactly what it was designed to do.

**Every transaction reverted.** `gasUsed = 350000/350000` — the whole limit consumed, nothing
produced. Replaying the call returns `out of gas`.

### Cause

The gas limit was a fixed 350,000, chosen because Monad charges the limit rather than the usage
so a tight limit saves money. That reasoning is sound and the number was never checked against
what the work costs. Documented precompile costs:

| function | gas |
|---|---|
| `withdraw(uint64,uint8)` | 68,675 |
| `claimRewards(uint64)` | 155,375 |

Three positions with rewards is `3 x 224,050 = 672,150` before base cost, calldata, contract
overhead and the sweep — about **776,000**. The limit was less than half of it.

Worse, the contract's own `WITHDRAW_GAS_CAP` is 400,000, **larger than the entire transaction
limit**. The first inner call alone tried to forward more gas than the transaction had.

### Why it produced nothing rather than partial results

The staking precompile consumes all gas on a failed call. There is no partial rescue to salvage
from an under-sized limit — the attempt is simply lost, at full cost, and being short is fatal
while being long only costs the difference.

### Fixed

`estimateRescueGas(positionCount, claimRewards)` sizes the limit from the actual work with a
25% margin. One position needs ~373k, three ~970k, five ~1.57M. `GAS_LIMIT` still overrides.

### A second finding, from the same numbers

`claimRewards` is 155,375 gas per position — **70% of the per-position cost**. In this run the
delegator held 0.263 MON of unclaimed rewards; claiming it across three positions costs roughly
1.1 MON in gas at a 20x multiplier. Claiming was a net loss of about 0.8 MON.

Rewards accrued *to the withdrawal itself* are paid by `withdraw()` regardless, so this only
governs the separate delegator reward pot. `rewardsWorthClaiming()` now makes it a decision
rather than a default, and skipping it more than halves the gas requirement.

---

## Q14 — The first live rescue attempt failed, and how it failed matters more than that it did

On 2026-08-04 the hot path was armed against 500 MON maturing at epoch 1019, launched under
`nohup`, and left for two days. At epoch 1029 the on-chain state read:

| | |
|---|---|
| safe address | 4.8064518194 MON — **identical to baseline**, nothing delivered |
| guardian | 29.997805757624869204 MON — **identical to the wei**, so it never sent a transaction |
| positions | all three still pending, 500 MON, matured at 1019 and unclaimed |

The cause was not a crash under load, a reorg, or a lost race. The process died **in the first
second**, on an import:

```
SyntaxError: The requested module '@monrescue/shared' does not provide an export
named 'detectLocalNode'
```

A `git pull` updated the source of `packages/shared` but nothing rebuilt its `dist/`. The
consuming packages import from the built output, so they loaded a stale module that predated
the export they needed.

### Why this is worth a finding rather than a changelog line

**Nothing reported it.** Not the process, which had already exited; not the guardian balance,
which never moved; not any alert. The failure was indistinguishable from "armed and waiting"
for two days, and was only caught by reading chain state and asking why the guardian's balance
was unchanged to the wei.

This is precisely the failure mode `STRATEGY.md` names as the one that silently loses a rescue —
"our node being down, lagging, restarting or rate-limiting at the unlock block … not detectable
from inside the process". It arrived on the very first live attempt, and from a direction not
anticipated: not infrastructure, but a build artifact.

### What changed

- Every run script in `research`, `rescue-cli` and `watcher` now rebuilds `@monrescue/shared`
  before executing. Startup cost is irrelevant for a daemon that waits hours; a stale `dist`
  that dies on import is not.
- `nohup` is not supervision. Production needs `systemd` with `Restart=always`, plus a
  heartbeat that is visible from **outside** the process — because a process that is not running
  cannot tell you it is not running.

### What was not lost

Withdrawal requests do not expire. The 500 MON stayed claimable at epoch 1019 and was still
claimable at 1029, ten epochs later. On a real compromise the attacker would have taken it; in
this test nobody was competing. That the funds survived is luck, not design, and does not
soften the lesson.

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

### `withdrawEpoch` semantics — CONFIRMED on testnet 2026-08-04

Two undelegates from `0xa5d75b…86B3`, both fired in **epoch 1017 before the boundary block**:

| | |
|---|---|
| tx | `0x51e00cc3…` (slot 0), `0x9688a803…` (slot 1) |
| epoch at submission | 1017, `inEpochDelayPeriod = false` |
| on-chain `withdrawEpoch` | **1018** |

`withdrawEpoch` = `n+1` = the **activation** epoch, exactly as the struct comment says
("epoch when undelegate stake deactivates") and **not** the current epoch as the `undelegate`
pseudocode claims. The pseudocode is wrong.

So `maturityEpoch(withdrawEpoch) = withdrawEpoch + WITHDRAWAL_DELAY` is correct, and these
positions become claimable at **epoch 1019**.

**A false alarm worth recording.** The run printed "prediction and on-chain value differ" on
both legs. That was a defect in `setup-stake.ts`, not a finding: it compared
`withdrawableAtEpoch()` — which returns *maturity* (1019) — against `withdrawEpoch`, which
holds *activation* (1018). Two different quantities, so every correct run looked like a
mismatch. Both numbers actually agreed on maturity 1019, which confirms the model rather than
contradicting it. Fixed to compare activation against activation and print maturity separately.

Still open: the boundary contrast. Both legs landed before the boundary block, so `n+2`
activation is predicted but unmeasured. A third undelegate fired after block 50,850,000 (while
`inEpochDelayPeriod` is true) would close it.

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
| Q2 7702 / `0x04` submission via viem | **VERIFIED on testnet** — tx `0x3aa6a9f3…`, code became `0xef0100147bc559…` exactly as expected | Closed |
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
