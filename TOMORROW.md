# Tomorrow: contract deploy + unstake battle test

Ordered by dependency, not importance. Steps 0–4 are time-critical and must be done early —
everything after them waits on an epoch boundary.

---

## PRIORITY: the boundary A/B experiment

Two undelegates of the same size, in the **same epoch**, on different slots — one before the
boundary block, one after. This settles in a single run what the documentation contradicts
itself on.

```bash
CHAIN_ID=10143 VALIDATOR_ID=<id> AMOUNT=<n> PHASE=ab SLOT_A=0 SLOT_B=1 \
  pnpm --filter @monrescue/research boundary
```

`PHASE=ab` fires leg A now, then **polls and fires leg B automatically** once the boundary
passes. Do not try to hit leg B by hand: its window is only `EPOCH_DELAY_ROUNDS` wide —
measured at 4,962–4,999 blocks, about **25 minutes**. Missing it costs a day, because each leg
then needs its own unbonding period.

**Predictions under test** (from the implementation, not the docs), with the experiment run in
epoch `n`:

| leg | fired | predicted `withdrawEpoch` | predicted claimable |
|---|---|---|---|
| A | before the boundary block | `n+1` | `n+2` |
| B | after the boundary block | `n+2` | `n+3` |

If both instead record `n`, then the docs' `undelegate` pseudocode (`epoch = getEpoch()`) is
right and our `maturityEpoch()` is wrong — which would mean we fire an epoch **late**, not
early. Either way the on-chain value wins and `FINDINGS.md` Q11 gets updated.

Read it back any time with `PHASE=report`.

### Two things that will bite

**Freshly staked MON cannot be undelegated yet.** Only *activated* stake can be removed —
"pending delegations cannot be removed until they are active". A delegation made during epoch
`n` activates at `n+1` (or `n+2` past the boundary). The stake made today activates at epoch
**1013**, so nothing can be undelegated before that epoch begins. The script checks active stake
and refuses rather than reverting on-chain.

**Both legs need to be in the same epoch, and you need enough active stake for two.** Per epoch
the shape is: ~3.77h of "before boundary" (leg A can go anywhere in it), then a ~25 min delay
period (leg B). Run `PHASE=ab` early in an epoch and it handles the wait itself.

Concrete windows, from a live reading at epoch 1012 / block 50,587,531:

```
epoch 1013 begins ~block 50,604,900
  leg A window: 50,604,900 .. 50,649,999   (~3.77h)
  leg B window: 50,650,000 .. ~50,655,000  (~25 min)
epoch 1014 begins ~block 50,654,900
  leg A window: 50,654,900 .. 50,699,999
  leg B window: 50,700,000 .. ~50,705,000
```

Re-derive these on the day — the script does it live, so just run it and read the header.

---

## The scheduling constraint (read first)

Unbonding takes **2–3 epochs, ~8–13 hours**. So the undelegate has to land early in the day or
the battle test slips to the next day.

Worse, there is a hard deadline inside that: the next-epoch snapshot is taken at the **start of
the boundary block**, before user transactions.

- undelegate lands **before** the boundary block → matures at `n+2`
- undelegate lands **in or after** it → matures at `n+3`

That is a full epoch (~4.2h) decided by one block. **Check the deadline before doing anything
else:**

```bash
CHAIN_ID=10143 GUARDIAN_PRIVATE_KEY=<any> VICTIM_ADDRESS=<victim> \
  pnpm --filter @monrescue/rescue-cli emergency
```

It prints `DEADLINE: land the undelegate before block N (~Xh)` as its first output, before it
does anything else. If that number is small, get step 4 done immediately and set up afterwards.

---

## 0. Prerequisites

Three addresses, all throwaway testnet keys:

| Role | Env | Funding |
|---|---|---|
| Victim / attacker (same key — that is what compromise means) | `RESEARCH_PRIVATE_KEY` | enough to stake + gas |
| Guardian (pays gas, chooses nothing) | `GUARDIAN_PRIVATE_KEY` | **> 10 MON** |
| Safe address (destination, immutable) | `SAFE_ADDRESS` | none |
| Attacker sink (where the adversary tries to send) | `ATTACKER_SINK` | none |

Fund at https://faucet.monad.xyz.

**Check what the faucet actually gives before planning the reserve tests.** `DUST_THRESHOLD` is
1 gwei so staking can be tiny, but the guardian genuinely needs >10 MON: Monad caps an account's
inflight gas at `min(10 MON, lagged balance)` over 3 blocks, so a thin guardian gets throttled
at exactly the moment it needs to retry.

```bash
pnpm install
pnpm --filter @monrescue/shared build
CHAIN_ID=10143 pnpm --filter @monrescue/research verify   # no key needed
CHAIN_ID=10143 pnpm --filter @monrescue/research bench    # ranks endpoints, sets EPOCH_POLL_MS
```

---

## 1. Build and deploy the contract

```bash
cd contracts && npm i solc && node build.mjs && cd ..
CHAIN_ID=10143 pnpm --filter @monrescue/research deploy
```

Deploy verifies `SAFE_ADDRESS()` back off-chain and aborts on mismatch. Put the address in
`RESCUE_CONTRACT`.

**Proves:** the contract deploys and the destination lock is real, not a convention.

## 2. Script A — does 7702 work here at all

```bash
CHAIN_ID=10143 pnpm --filter @monrescue/research script:a
```

Asserts the account's code becomes exactly `0xef0100 ‖ contract`.

**Proves:** viem submits a working type-`0x04` to Monad. Nothing downstream is worth running if
this fails.

## 3. Authorization window

```bash
CHAIN_ID=10143 AUTH_WINDOW_SIZE=64 AUTH_WINDOW_FILE=./window.json \
  pnpm --filter @monrescue/research make-window
```

Test harness only — production has the user sign in their own wallet. Note it signs **without**
`executor: 'self'` and with explicit nonces, because these are relayer-submitted. Getting that
wrong makes the authorization silently skip while still burning ~25k gas, which is the most
common 7702 integration bug.

## 4. Stake and undelegate — DO THIS EARLY

```bash
CHAIN_ID=10143 ACTION=delegate   VALIDATOR_ID=1 AMOUNT=<n> pnpm --filter @monrescue/research stake
CHAIN_ID=10143 ACTION=status                                pnpm --filter @monrescue/research stake
# once active, and BEFORE the boundary deadline:
CHAIN_ID=10143 ACTION=undelegate VALIDATOR_ID=1 AMOUNT=<n> pnpm --filter @monrescue/research stake
```

`undelegate` prints predicted vs on-chain `withdrawEpoch` and flags any disagreement. **The
on-chain value is authoritative** — the docs contradict themselves here, and any mismatch is a
finding worth recording.

Remember maturity is `withdrawEpoch + WITHDRAWAL_DELAY`, not `withdrawEpoch`. This was a real
off-by-one in our own code.

---

## 5. While waiting for the epoch — Script C

The reserve-balance contradiction is the biggest unresolved question and it needs no unlock.

```bash
CHAIN_ID=10143 pnpm --filter @monrescue/research script:c
```

The docs say two incompatible things about a delegated EOA:

- reserve-balance page: floor is `min(balance at start, 10 MON)` → a wallet starting near zero
  can be swept empty
- EIP-7702 page: any transaction dropping the balance below 10 MON reverts **unconditionally**

**The difference is "sweep everything" vs "always strand 10 MON".** `reserve.ts` implements the
permissive reading and that choice is currently unvalidated. Whatever this returns, update
`FINDINGS.md` Q3 and `reserveFloor()` to match.

Also worth testing while idle: **does `undelegate` accept a dust amount?** If it does, an
attacker holding the key can fill all 256 slots cheaply while leaving the stake bonded. Not
documented either way.

---

## 6. Script B — THE GATE

Run when `ACTION=status` says `CLAIMABLE NOW`.

```bash
CHAIN_ID=10143 pnpm --filter @monrescue/research script:b
```

Does `withdraw()` + native transfer land **atomically in one transaction**? Because no staking
function takes a recipient, rescued funds necessarily land on the compromised EOA; if the claim
and the sweep cannot share a transaction there is a block where liquid MON sits in a wallet the
attacker controls.

**Until `research/artifacts/q1-atomic-batch.json` exists, the rescue path is unproven and must
not be described as working.**

## 7. Script D — guardian trigger

```bash
CHAIN_ID=10143 pnpm --filter @monrescue/research script:d
```

**Proves:** a separate guardian key can fire the sweep, and no function anywhere accepts a
recipient address.

---

## 8. The battle test

Two processes racing for the same funds at the same unlock. This is the only honest measurement
of the product; everything else is a claim.

**Terminal 1 — us:**
```bash
CHAIN_ID=10143 VICTIM_ADDRESS=<victim> VALIDATOR_ID=1 WITHDRAW_ID=0 \
  SPRAY_ENABLED=true PRIORITY_FEE_MULTIPLIER=20 \
  pnpm --filter @monrescue/rescue-cli arm
```

**Terminal 2 — the attacker:**
```bash
CHAIN_ID=10143 MODE=naive ATTACKER_SINK=<sink> VALIDATOR_ID=1 WITHDRAW_ID=0 \
  ADVERSARY_FEE_MULTIPLIER=20 \
  pnpm --filter @monrescue/research adversary
```

`MODE=naive` is `withdraw()` then a separate transfer — two transactions with a gap, which is
what an ordinary attacker does and what our atomic single transaction exists to beat.

Run it several times, varying `ADVERSARY_FEE_MULTIPLIER` above and below ours. Ordering is a
priority gas auction on total gas price, so the expected result is that **whoever bids more
wins**, and latency only decides whether you make the cut for that proposal at all. If we win at
equal fee, that is latency; if we lose at lower fee, that is expected and not a bug.

### What to record every run

1. **Detection latency** — epoch flip → we notice.
2. **Broadcast latency** — per endpoint, printed by `broadcastEverywhere()`.
3. **Inclusion delay** — receipt block minus the block we fired in. This is the real score.
4. **Who got the money** — safe address balance vs attacker sink balance.
5. **Fee paid by each side.**

Then note: did we land in the **flip block itself**? We should — the epoch advances in
transaction 0 of that block (`syscallOnEpochChange`, verified at block 50,554,962), so a
withdraw in the same block already sees the new epoch. Landing one block later means we aimed
wrong.

### The interesting negative results

- **Attacker's `withdraw()` lands first.** Not a loss. The funds are now liquid on an EOA still
  delegated to a destination-locked contract, and `sweep()` takes them. `rescue()` deliberately
  does not abort when withdrawals fail, precisely because the likeliest cause is that the money
  already arrived. Verify this actually happens.
- **Attacker's transfer reverts on the reserve rule.** That is the delegation working as a brake:
  a delegated account cannot use the emptying exception.

---

## 9. If there is time — `MODE=atomic`

The sophisticated attacker re-delegates to their own batch contract to close the gap. Requires
writing a small attacker batch contract. Expected result: **they win if their re-delegation
lands before our rescue**, because it destroys our delegation. Our counter is the authorization
window re-asserting inside our own rescue transaction, since the authorization list is processed
before the top-level call.

This is the case worth knowing the true shape of, because it is the one we might be overselling.

---

## Open questions this day should close

| Question | Status | Closed by |
|---|---|---|
| Q1 atomic claim + transfer in one 7702 batch | **UNVERIFIED — gates everything** | Script B |
| Q3 reserve floor: `min(start, 10 MON)` or flat 10 MON | **UNVERIFIED — contradictory docs** | Script C |
| Q2 viem submits a working `0x04` | documented only | Script A |
| Q4 guardian-triggered destination-locked sweep | design only | Script D |
| Does `undelegate` accept dust? | undocumented | ad-hoc, step 5 |
| `withdrawEpoch` predicted vs on-chain | contradictory docs | step 4 output |
| Do we win the naive race, and by what margin? | unknown | step 8 |

## Do not

- Send MON to the victim EOA "to help". It recreates the exact race this design avoids and hands
  the attacker free money. The guardian pays all gas; the victim needs zero balance.
- Commit `window.json`, `.env`, or any key.
- Point anything at mainnet until Q1 and Q3 are closed.
