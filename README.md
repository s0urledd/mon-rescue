# MonRescue

A delegator-protection layer for [Monad](https://monad.xyz): an alert engine for staking
health, and a destination-locked rescue path for delegators whose keys have been compromised.

## Status

**Phase 0 closed. The rescue works.**

Transaction [`0x6c285d49…`](https://testnet.monadvision.com/tx/0x6c285d49425cd829bb74dc784818fcbd0279a8fcb4fa0736c98460d2b313e17b),
block 51,416,783: three matured withdrawals claimed from the staking precompile and
**500.112413 MON swept to the destination-locked safe address in a single block**, sent by a
guardian key that never held the victim's key.

| question | answer |
|---|---|
| Q1 — atomic claim + sweep in one 7702 transaction | **YES**, measured |
| Q2 — viem submits a working `0x04` to Monad | **YES**, measured |
| Q3 — reserve floor | `min(start, 10 MON)`; the "contradiction" was illusory |
| Q4 — a separate guardian can fire it | **YES**, same run |
| Q5 — can a withdrawal name a recipient | **NO** — which is why the rescue must be atomic |

Not yet done: the **battle test**. Every rescue so far was uncontested. Winning at an equal fee
is the result that means something.

## How it works

The attacker holds the seed and usually unstakes the position themselves. They cannot take it
immediately — `undelegate` puts funds behind `WITHDRAWAL_DELAY` for everyone, including them.
That delay is the entire product, and their own `Undelegate` event hands us the validator, the
slot, the amount and the exact maturity epoch.

At the unlock we fire one transaction that claims and sweeps atomically, to an address burned
into the contract at construction. No function anywhere takes a recipient, so even the attacker
calling it moves funds to the user's own safe address.

We never see a seed phrase or a private key.

## Operating notes

- **Run beside a Monad node.** Detection is ~8ms local against ~116ms remote, and both reads and
  broadcast go local first. Auto-detected at `127.0.0.1:8080`.
- **Fees are a MON budget per attempt**, not a multiplier — `eth_maxPriorityFeePerGas` returns a
  hardcoded 2 gwei on Monad, so multiplying it measured nothing. Attempts climb a cubic curve
  from 2x the p90 bid toward the budget.
- **Gas is charged on the limit, not usage, with no refunds**, and the staking precompile
  consumes all gas on failure. `estimateRescueGas()` sizes from position count; being short
  loses the whole attempt.
- **One guardian key per concurrently-armed customer** — Monad's inflight gas cap is per account
  and belongs to the guardian.
- `nohup` is not supervision. Use `systemd` with `Restart=always` and a heartbeat visible from
  outside the process.

`CLAUDE.md` carries the working context. `research/FINDINGS.md` has every claim with its
evidence. `STEPS.md` is the runbook.
