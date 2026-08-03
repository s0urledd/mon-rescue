# Tomorrow — step by step

Six blocks, in order. Each has a **gate**: if it fails, stop and think rather than pushing on,
because everything after it depends on it being true.

Two things are worth knowing before starting:

- **Epoch timing is already measured.** Boundary block is exactly `(epoch-1) × 50,000`, the
  epoch begins 4,962–4,999 blocks later, block time is 0.301s so an epoch is ~4.2h. Verified on
  four epochs against two independent archive nodes. You do not need to rediscover this — but
  Block 2 confirms the one part that is still only inferred.
- **Nothing else has been executed.** Every script compiles and runs to its guard clauses, and
  exactly one measurement artifact exists (the latency benchmark). The contract has never been
  deployed, no `0x04` has ever been submitted, and the rescue has never fired. Treat all of it
  as untested until it runs.

---

## Block 0 — Setup and baseline (~15 min, no funded key)

```bash
pnpm install
pnpm --filter @monrescue/shared build
CHAIN_ID=10143 pnpm --filter @monrescue/research verify
CHAIN_ID=10143 pnpm --filter @monrescue/research bench
```

`verify` re-checks every FINDINGS claim against live chain. `bench` ranks RPC endpoints by
block-observation lead and prints an `EPOCH_POLL_MS` floor — polling faster than the round-trip
cannot help.

Prepare four addresses, all throwaway testnet keys:

| Role | Env | Funding |
|---|---|---|
| Victim (also the attacker — same key, that is what compromise means) | `RESEARCH_PRIVATE_KEY` | stake + gas |
| Guardian (pays gas, chooses nothing) | `GUARDIAN_PRIVATE_KEY` | **> 10 MON** |
| Safe address (destination, immutable) | `SAFE_ADDRESS` | none — **use an EOA** |
| Attacker sink | `ATTACKER_SINK` | none |

The guardian threshold is not cosmetic: Monad caps an account's inflight gas at
`min(10 MON, lagged balance)` over 3 blocks, so a thin guardian gets throttled exactly when it
needs to retry. The safe address should be a plain EOA — the sweep is a native transfer, and a
contract without a payable receive would make it fail.

**Gate:** `verify` passes and the guardian holds >10 MON.

---

## Block 1 — Deploy and prove EIP-7702 works at all (~20 min)

```bash
cd contracts && npm i solc && node build.mjs && cd ..
CHAIN_ID=10143 pnpm --filter @monrescue/research deploy      # -> RESCUE_CONTRACT
CHAIN_ID=10143 pnpm --filter @monrescue/research script:a
```

`deploy` reads `SAFE_ADDRESS()` back off-chain and aborts on mismatch, so the destination lock
is verified rather than assumed.

`script:a` submits a type-`0x04` and asserts the account's code becomes exactly
`0xef0100 ‖ contract`.

**Gate — the real one:** nobody has ever confirmed that viem submits a working `0x04` to Monad.
Scanning 40 testnet blocks found zero 7702 transactions, so it cannot be checked by observation.
If this fails, the entire delegation model needs a different submission path and there is no
point running anything below it.

---

## Block 2 — Understand the unstake timing (this is your A/B)

You are firing these by hand, so the only thing that matters is **which side of the boundary
block each one lands on**. Check where you are first:

```bash
CHAIN_ID=10143 GUARDIAN_PRIVATE_KEY=$G VICTIM_ADDRESS=$V \
  pnpm --filter @monrescue/rescue-cli emergency
```

Its first output is the deadline: `land the undelegate before block N`. That block is the
boundary. Before it → activation `n+1`; in it or after → activation `n+2`.

Then fire two undelegates **in the same epoch**, on **different slots**:

```bash
# leg A — before the boundary block
CHAIN_ID=10143 ACTION=undelegate VALIDATOR_ID=<id> AMOUNT=<n> WITHDRAW_ID=0 \
  pnpm --filter @monrescue/research stake

# leg B — after the boundary block, inside the ~25 min delay period
CHAIN_ID=10143 ACTION=undelegate VALIDATOR_ID=<id> AMOUNT=<n> WITHDRAW_ID=1 \
  pnpm --filter @monrescue/research stake
```

Each prints the predicted `withdrawEpoch` next to the on-chain one and flags a mismatch.

### What this settles

**The docs contradict themselves about what `withdrawEpoch` means.** The struct comment says
"epoch when undelegate stake deactivates"; the `undelegate` pseudocode stores `getEpoch()`, the
current epoch. I read the implementation and concluded it is the activation epoch, so
`maturity = withdrawEpoch + WITHDRAWAL_DELAY`. **That is inferred, not confirmed.** If it is
wrong we fire an epoch *late*, which is worse than early.

Expected: leg A records `n+1`, leg B records `n+2`, and B − A = exactly 1.

Record both values. If B − A is not 1, or either differs from the prediction, update
`maturityEpoch()` and `FINDINGS.md` before continuing — everything downstream times off it.

Timing note: only *activated* stake can be undelegated, so a delegation made this epoch cannot
be removed until the next one begins.

**Gate:** you know, from on-chain values, exactly which epoch each leg matures in.

---

## Block 3 — While waiting: the reserve-balance question (~30 min)

Unbonding is 2–3 epochs, so there are hours here. Spend them on the biggest unresolved question,
which needs no unlock:

```bash
CHAIN_ID=10143 pnpm --filter @monrescue/research script:c
```

The docs say two incompatible things about a delegated EOA:

- reserve-balance page: floor is `min(balance at start, 10 MON)` → an account starting near zero
  can be swept empty
- EIP-7702 page: any transaction dropping the balance below 10 MON reverts **unconditionally**

**"Sweep everything" versus "always strand 10 MON".** `reserve.ts` implements the permissive
reading and that choice is currently unvalidated. Whatever comes back, update `reserveFloor()`
and FINDINGS Q3.

Also worth testing while idle, since it is undocumented either way: **does `undelegate` accept a
dust amount?** If it does, someone holding the key can fill all 256 slots cheaply while leaving
the stake bonded.

**Gate:** the reserve floor is a measured number, not a guess.

---

## Block 4 — Script B, the gate (at the unlock)

Run when the position is claimable.

```bash
CHAIN_ID=10143 pnpm --filter @monrescue/research script:b
```

Does `withdraw()` + native transfer land **atomically in one transaction**? Because no staking
function accepts a recipient, rescued funds necessarily land on the compromised EOA. If claim
and sweep cannot share a transaction, there is a block in which liquid MON sits in a wallet the
attacker controls, and the product is a different shape.

**Gate — the biggest one in the project.** Until
`research/artifacts/q1-atomic-batch.json` exists, the rescue path is unproven. Do not describe
it as working, to anyone, before that file exists.

---

## Block 5 — Guardian trigger (~15 min)

```bash
CHAIN_ID=10143 pnpm --filter @monrescue/research script:d
```

Proves a *separate* guardian key can fire the sweep and that no function anywhere accepts a
recipient address.

**Gate:** the guardian can rescue without holding the victim's key.

---

## Block 6 — Beating the attacker (the point of the day)

This is the part you actually care about, and it only means something if Blocks 1–5 passed.

### 6a. Arm

```bash
CHAIN_ID=10143 AUTH_WINDOW_SIZE=64 AUTH_WINDOW_FILE=./window.json \
  pnpm --filter @monrescue/research make-window

CHAIN_ID=10143 VICTIM_ADDRESS=$V AUTH_WINDOW_FILE=./window.json \
  pnpm --filter @monrescue/rescue-cli arm
```

`arm` now **discovers positions from the `Undelegate` events themselves** — validator, slot,
amount and maturity all come out of the unstake transaction, so there is nothing to type.
`VALIDATOR_IDS` remains only as an override.

Watch for the line `pre-signed in Xms`. That is the whole design: everything expensive happens
while idle, and the flip window only broadcasts.

### 6b. Race it

Second terminal, at the same unlock:

```bash
CHAIN_ID=10143 MODE=naive ATTACKER_SINK=$SINK VALIDATOR_ID=<id> WITHDRAW_ID=0 \
  ADVERSARY_FEE_MULTIPLIER=20 \
  pnpm --filter @monrescue/research adversary
```

`MODE=naive` is `withdraw()` then a separate transfer — two transactions with a gap, which is
what an ordinary attacker does and what our single atomic transaction exists to beat. Both
sides pre-sign, so it is a fair race.

Run it several times with `ADVERSARY_FEE_MULTIPLIER` below, equal to, and above ours.

### What to record every run

1. Detection latency — epoch flip to noticing.
2. Broadcast latency per endpoint.
3. **Inclusion delay** — receipt block minus the block we fired in. The real score.
4. Who got the money: safe address balance vs attacker sink.
5. Fee paid by each side.
6. **Did we land in the flip block itself?** We should — the epoch advances in transaction 0 of
   that block, so a withdraw there already sees the new epoch. Landing one block later means we
   aimed wrong.

### How to read the result — set expectations now

Ordering is a **priority gas auction on total gas price**. Latency only decides whether we make
the cut for a given proposal; the fee decides position within it.

So: **losing at a lower fee is the expected outcome, not a bug.** The result that means
something is winning at an *equal* fee — that is latency and pre-staging doing their job. If we
lose at equal fee, the pre-signing or the broadcast path has a problem worth finding.

### Two "failures" that are actually successes

- **The attacker's `withdraw()` lands first.** Not a loss. The funds are now liquid on an EOA
  still delegated to a destination-locked contract, and `sweep()` takes them. `rescue()`
  deliberately does not abort when withdrawals fail, precisely because the likeliest cause is
  that the money already arrived. Confirm this actually happens — it is the single most valuable
  behaviour to verify.
- **The attacker's transfer reverts on the reserve rule.** That is the delegation working as a
  brake: a delegated account cannot use the emptying exception.

---

## If there is time — the sophisticated attacker

`MODE=atomic`: the attacker re-delegates to their own batch contract to close the gap. Needs a
small attacker contract written first.

Expected: **they win if their re-delegation lands before our rescue**, because it replaces our
delegated code. Our counter is the authorization window — each pre-signed attempt carries a
slice of it, and the authorization list is processed *before* the top-level call, so our
transaction re-asserts our delegation and then rescues, atomically.

This is the case worth knowing the true shape of, because it is the one we are most likely to be
overselling.

---

## What a good day looks like

By the end, these should be measured rather than assumed:

| Question | Answer comes from |
|---|---|
| Does viem submit a working `0x04` to Monad? | Block 1 |
| What does `withdrawEpoch` actually record? | Block 2 |
| Does crossing the boundary cost exactly one epoch? | Block 2 |
| Reserve floor: `min(start, 10 MON)` or flat 10 MON? | Block 3 |
| **Is atomic claim+sweep possible?** | Block 4 |
| Can a separate guardian fire it? | Block 5 |
| Do we beat a naive attacker at equal fee, and by how much? | Block 6 |
| Does the sweep still work after the attacker withdraws first? | Block 6 |

## Do not

- Send MON to the victim EOA "to help". It recreates the exact race this design avoids and hands
  the attacker free money. The guardian pays all gas; the victim needs zero balance.
- Commit `window.json`, `.env`, or any key.
- Point anything at mainnet until Blocks 2, 3 and 4 have passed.
