# MonRescue testnet runbook

The order to run things in, and what each step proves. Everything here targets **testnet
(chainId 10143)**. Nothing in this runbook should be pointed at mainnet until Q1 is closed.

Secrets are supplied at runtime. Never commit a key.

---

## Step 0 — measure before you spend anything

No funded key required.

```bash
pnpm install
pnpm --filter @monrescue/shared build
CHAIN_ID=10143 pnpm --filter @monrescue/research verify   # every FINDINGS.md claim, checked live
CHAIN_ID=10143 pnpm --filter @monrescue/research bench    # latency + who-sees-blocks-first
```

`bench` is the tool that answers "what is the fastest version". It ranks endpoints by **block
observation lead** — which node reports a new block height first — because on Monad there is
no global mempool and proximity to the leader is what decides inclusion, not raw ping.

Take two things from its output:

- **Ranked broadcast order** → paste into `RPC_POOL` in `packages/shared/src/chains.ts`.
- **`EPOCH_POLL_MS`** → put in the repo-root `.env`.

The benchmark ranks the poll endpoint by round-trip and the broadcast order by block-observation lead — different questions. Running beside your own node collapses detection latency by roughly an order of magnitude. Polling faster than the
round-trip is wasted; the benchmark tells you where that floor is. **Re-run this on mainnet** —
the ranking there will not be the same, and the endpoint that wins on testnet is not
guaranteed to win on mainnet.

---

## Step 1 — keys and funding

You need **three** addresses. Keep them distinct; the separation is the security model.

| Role | What it is | Funding |
|---|---|---|
| `RESEARCH_PRIVATE_KEY` | the test "victim" | needs MON to stake |
| `GUARDIAN_PRIVATE_KEY` | pays gas, broadcasts, chooses nothing | **> 10 MON** (see note) |
| `SAFE_ADDRESS` | destination, hard-locked into the contract | no funding needed |

Fund from https://faucet.monad.xyz.

> **Guardian funding is not cosmetic.** Monad caps an account's total gas spend across its
> inflight transactions (last 3 blocks) at `min(10 MON, lagged balance)`. A guardian sitting
> near zero will have its retries throttled at exactly the moment it needs to retry. Keep it
> comfortably above 10 MON.

Copy `.env.example` to `.env` at the repo root and fill it in — every script loads it.

---

## Step 2 — build and deploy the rescue contract

```bash
pnpm run build:contracts
CHAIN_ID=10143 pnpm --filter @monrescue/research deploy:contract
```

`deploy` refuses to proceed if `SAFE_ADDRESS` is a precompile, and after deployment it reads
`SAFE_ADDRESS()` back off-chain and aborts if it does not match — the destination lock is
verified, not assumed. Put the printed address in `RESCUE_CONTRACT`.

Deploy **one instance per protected user**. A 7702 delegation is publicly readable via
`eth_getCode`, so a single shared singleton would fingerprint every protected wallet and tell
an attacker exactly what to re-delegate away from.

---

## Step 3 — Script A: does 7702 work here at all?

```bash
CHAIN_ID=10143 pnpm --filter @monrescue/research script:a
```

Submits a type-`0x04` transaction and asserts the account's code becomes exactly
`0xef0100 ‖ rescueContract`. Proves viem is a viable submission path before anything is built
on it. Scanning 40 testnet blocks found zero 7702 transactions, so this cannot be confirmed by
observation — it has to be submitted.

---

## Step 4 — create an unbonding position

```bash
CHAIN_ID=10143 ACTION=delegate   VALIDATOR_ID=1 AMOUNT=100 pnpm --filter @monrescue/research stake
CHAIN_ID=10143 ACTION=status                                pnpm --filter @monrescue/research stake
# once the delegation is active:
CHAIN_ID=10143 ACTION=undelegate VALIDATOR_ID=1 AMOUNT=100 pnpm --filter @monrescue/research stake
```

`undelegate` prints both the predicted unlock epoch and the on-chain `withdrawEpoch`, and
flags any disagreement — the staking reference is ambiguous about which epoch that field
records, so **the on-chain value is authoritative** and any mismatch belongs in FINDINGS.md.

Then wait. `WITHDRAWAL_DELAY` is one epoch, and an epoch is ~4.2h at the measured 0.301s block time. Poll with
`ACTION=status` until it prints `CLAIMABLE NOW`.

---

## Step 5 — Script B: THE GATE

```bash
CHAIN_ID=10143 pnpm --filter @monrescue/research script:b
```

This is the question the whole product rests on: does `withdraw()` + native transfer land
**atomically in one transaction**? Because no staking function accepts a recipient (Q5),
rescued funds necessarily land on the compromised EOA. If claim and sweep cannot share a
transaction, there is a block where liquid MON sits in a wallet the attacker controls.

A passing run writes a transaction hash to `research/artifacts/q1-atomic-batch.json`. **Until
that file exists, the rescue path is unproven and must not be described as working.**

---

## Step 6 — Scripts C and D

```bash
CHAIN_ID=10143 pnpm --filter @monrescue/research script:c   # exact reserve-rule revert behaviour
CHAIN_ID=10143 pnpm --filter @monrescue/research script:d   # guardian trigger + destination lock
```

Script C is worth reading closely: it tests that the floor is `min(start, 10 MON)` and **not**
a flat 10 MON. If that holds, a wallet already drained to zero can be swept in full — which is
the common real case.

Script D proves a *separate* guardian key can fire the sweep, and that no function anywhere
accepts a recipient address.

---

## Step 7 — arm the hot path

```bash
# config lives in the repo-root .env
CHAIN_ID=10143 pnpm --filter @monrescue/rescue-cli arm
```

It pre-signs the rescue, holds it in memory, polls `getEpoch()`, and fires on the transition
via simultaneous multi-RPC broadcast. It refuses to arm against an account that is not
delegated, and it runs the reserve check up front rather than discovering a revert on-chain.

---

## Measuring "fastest", honestly

After a successful Script B or an armed fire, the numbers that matter are:

1. **Detection latency** — epoch transition → we notice. Bounded below by the RPC round-trip;
   `bench` measures it.
2. **Broadcast latency** — printed per endpoint by `broadcastEverywhere()`.
3. **Inclusion delay** — receipt block minus the block we fired in. This is the real score.

Log all three every run. "It felt fast" is not a measurement, and the difference between one
block and two is the whole product.

An important asymmetry to keep in mind while testing: **a failed rescue is usually retryable.**
If the attacker calls `withdraw()` alone, the funds land on the EOA — still delegated to a
destination-locked contract — and `sweep()` takes them. Losing the first race is not
necessarily losing the funds.
