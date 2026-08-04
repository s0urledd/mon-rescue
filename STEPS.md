# Step by step

Literal sequence, from a fresh clone to a measured rescue. Run them in order; each step says
what it produces and what to check before moving on.

`TOMORROW.md` explains *why* each step matters. This file is just the doing.

---

## 1. Install

```bash
pnpm install
pnpm --filter @monrescue/shared build
```

`shared` must be built first — everything imports from its `dist`.

**Check:** no errors. If `tsx` is missing, `pnpm install` again.

---

## 2. Configure

```bash
cp .env.example .env
pnpm --filter @monrescue/research genkeys   # prints a ready-to-paste block
```

`genkeys` generates the four test identities and explains each one inline. Paste its output
into `.env`.

### The four addresses

| | Role | What it is | Needs a private key? | Funding |
|---|---|---|---|---|
| 1 | **Victim** (`RESEARCH_PRIVATE_KEY`) | The compromised wallet. It holds the stake. In the battle test the adversary signs with this *same* key — "the attacker has the seed" means exactly that, so victim and attacker are one identity. | yes | stake + gas for the adversary legs |
| 2 | **Guardian** (`GUARDIAN_PRIVATE_KEY`) | Pays all gas and broadcasts the rescue. Chooses nothing — the destination is immutable in the contract, so even a stolen guardian key cannot redirect funds. | yes | **> 10 MON** |
| 3 | **Safe address** (`SAFE_ADDRESS`) | The only place rescued funds can ever go, burned into the contract at construction and unchangeable. No script here ever uses its key. | no — address only | none |
| 4 | **Attacker sink** (`ATTACKER_SINK`) | Where the simulated attacker tries to send. Test-only; it is how you tell who won. | no — address only | none |

Two constraints that matter:

- **Guardian above 10 MON.** Monad caps an account's total gas across its inflight transactions
  at `min(10 MON, lagged balance)` over 3 blocks, so a thin guardian is throttled at exactly the
  moment it needs to retry.
- **Safe address must be a plain EOA**, and in the real flow a key that has never touched the
  compromised machine. The sweep is a native transfer, so a contract without a payable receive
  would make it fail.

In production only #2 and #3 exist as our concern: the victim is the user (who signs in their
own wallet and never shares a key), and there is no attacker sink. Every script loads this file automatically — repo-root first, then
any package-local `.env`, and real environment variables always win.

Get testnet MON from https://faucet.monad.xyz for the victim and the guardian.

**Check, and do not skip this:**

```bash
CHAIN_ID=10143 pnpm --filter @monrescue/research verify
CHAIN_ID=10143 pnpm --filter @monrescue/research bench
```

`verify` re-checks every documented claim against the live chain and needs no key. `bench` ranks
RPC endpoints and prints an `EPOCH_POLL_MS` floor — polling faster than the round-trip cannot
help, it only burns rate limit.

Guardian must hold **more than 10 MON**. Not cosmetic: below that, retries get throttled at the
exact moment they matter.

---

## 3. Deploy the rescue contract

```bash
pnpm run build:contracts
pnpm --filter @monrescue/research deploy:contract
```

Deploys one instance for this user with `SAFE_ADDRESS` immutable, then reads it back off-chain
and aborts on mismatch — the destination lock is verified, not assumed.

**Produces:** a contract address. Put it in `.env` as `RESCUE_CONTRACT`.

---

## 4. Prove EIP-7702 works here at all

```bash
pnpm --filter @monrescue/research script:a
```

Submits a type-`0x04` and asserts the account's code becomes exactly `0xef0100 ‖ contract`.

**This is the first real gate.** Nobody has confirmed that viem submits a working `0x04` to
Monad, and it cannot be checked by observation — scanning 40 testnet blocks found zero 7702
transactions. If this fails, stop: the delegation model needs a different submission path and
nothing below it is meaningful.

---

## 5. Stake

```bash
ACTION=delegate VALIDATOR_ID=1 AMOUNT=100 pnpm --filter @monrescue/research stake
ACTION=status                              pnpm --filter @monrescue/research stake
```

Wait for `status` to show the stake as active. **Only activated stake can be undelegated** — a
delegation made this epoch cannot be removed until the next one begins.

---

## 6. Unstake — and watch the boundary

First, see where you are:

```bash
pnpm --filter @monrescue/rescue-cli emergency
```

Its first line is `DEADLINE: land the undelegate before block N`. That block is the boundary.
Landing before it means maturity at `n+2`; landing in or after it means `n+3` — a full epoch,
about 4.2 hours, decided by one block.

Then fire two legs, **same epoch, different slots**:

```bash
# leg A — before the boundary block
ACTION=undelegate VALIDATOR_ID=1 AMOUNT=50 WITHDRAW_ID=0 \
  pnpm --filter @monrescue/research stake

# leg B — after it, inside the ~25 min delay period
ACTION=undelegate VALIDATOR_ID=1 AMOUNT=50 WITHDRAW_ID=1 \
  pnpm --filter @monrescue/research stake
```

Each prints predicted vs on-chain `withdrawEpoch` and flags a mismatch.

**Record both.** Expected: A → `n+1`, B → `n+2`, difference exactly 1. If either differs from
the prediction, `maturityEpoch()` is wrong and everything downstream mistimes — fix it before
continuing.

---

## 7. While waiting — the reserve question

Unbonding is 2–3 epochs, so there are hours here. Spend them on the biggest open question, which
needs no unlock:

```bash
pnpm --filter @monrescue/research script:c
```

The docs say two incompatible things: floor is `min(balance at start, 10 MON)`, or any drop
below 10 MON reverts unconditionally. That is the difference between sweeping everything and
always stranding 10 MON. `reserve.ts` currently implements the permissive reading, unvalidated.

Whatever comes back, update `reserveFloor()` and FINDINGS Q3.

---

## 8. Sign the authorization window

```bash
AUTH_WINDOW_SIZE=64 pnpm --filter @monrescue/research make-window
```

Writes `window.json`. Test harness only — in production the user signs these in their own wallet
and we never see a key.

Must come **after** step 3, since it signs a delegation to `RESCUE_CONTRACT`.

---

## 9. Script B — the gate

Run when `ACTION=status` says `CLAIMABLE NOW`.

```bash
pnpm --filter @monrescue/research script:b
```

Does `withdraw()` + native transfer land **atomically in one transaction**? Because no staking
function accepts a recipient, rescued funds land on the compromised EOA; if claim and sweep
cannot share a transaction, there is a block where liquid MON sits in a wallet the attacker
controls.

**Until `research/artifacts/q1-atomic-batch.json` exists, the rescue path is unproven.** Do not
describe it as working before then.

---

## 10. Script D — guardian trigger

```bash
pnpm --filter @monrescue/research script:d
```

Proves a *separate* guardian key can fire the sweep, and that no function anywhere accepts a
recipient address.

---

## 11. Arm the rescue

```bash
pnpm --filter @monrescue/rescue-cli arm
```

Discovers positions from the `Undelegate` events themselves — validator, slot, amount and
maturity all come out of the unstake transaction, so there is nothing to type.

Watch for `pre-signed in Xms`. That line is the whole design: everything expensive happens while
idle, and the flip window does nothing but broadcast.

It then sleeps through the wait, polls harder as the boundary approaches, and bursts inside the
~100-block flip window.

---

## 12. The battle test

Second terminal, same unlock:

```bash
MODE=naive ADVERSARY_FEE_MULTIPLIER=20 WITHDRAW_ID=0 \
  pnpm --filter @monrescue/research adversary
```

`MODE=naive` is `withdraw()` then a separate transfer — two transactions with a gap, which is
what an ordinary attacker does. Both sides pre-sign, so it is a fair race.

Run it several times with the adversary's fee below, equal to, and above ours.

**Record each run:** detection latency, broadcast latency, inclusion delay (receipt block minus
the block we fired in), who got the money, fee paid by each side, and whether we landed in the
**flip block itself** — we should, since the epoch advances in transaction 0 of that block.

**Read the result correctly.** Ordering is a priority gas auction on total gas price. Latency
only decides whether we make the cut for a proposal; fee decides position within it. So losing
at a lower fee is expected, not a bug. The meaningful result is **winning at an equal fee** —
that is pre-staging doing its job. Losing at equal fee means something in the signing or
broadcast path is worth finding.

**Two "failures" that are wins:** if the attacker's `withdraw()` lands first, the funds are
liquid on an EOA still delegated to a destination-locked contract and `sweep()` takes them —
confirm this actually happens, it is the most valuable single observation of the day. If the
attacker's transfer reverts on the reserve rule, the delegation is working as a brake.

---

## Quick reference

| Step | Command | Needs |
|---|---|---|
| 1 | `pnpm install && pnpm --filter @monrescue/shared build` | — |
| 2 | `... research verify` / `bench` | nothing funded |
| 3 | `... research deploy:contract` | `SAFE_ADDRESS`, `GUARDIAN_ADDRESS` |
| 4 | `... research script:a` | `RESCUE_CONTRACT` |
| 5 | `ACTION=delegate ... research stake` | `VALIDATOR_ID`, `AMOUNT` |
| 6 | `... rescue-cli emergency` then `ACTION=undelegate ...` | `VICTIM_ADDRESS` |
| 7 | `... research script:c` | — |
| 8 | `... research make-window` | `RESCUE_CONTRACT` |
| 9 | `... research script:b` | claimable position |
| 10 | `... research script:d` | `GUARDIAN_PRIVATE_KEY` |
| 11 | `... rescue-cli arm` | `window.json` |
| 12 | `... research adversary` | `ATTACKER_SINK` |

## Never

- Send MON to the victim EOA "to help". The guardian pays all gas and the victim needs zero
  balance; funding it recreates the exact race this design avoids and donates to the attacker.
- Commit `.env` or `window.json`.
- Point anything at mainnet until steps 6, 7 and 9 have passed.
