# MonRescue

A delegator-protection layer for [Monad](https://monad.xyz): an alert engine for staking
health, and a destination-locked rescue path for delegators whose keys have been compromised.

**Status: Phase 0 (research). The rescue path is not proven yet — see
[`research/FINDINGS.md`](research/FINDINGS.md).** The alert engine is unblocked and is the
first thing to ship.

## What this is

Two components, in priority order:

1. **Alert engine + public Telegram bot** (`watcher/`) — send a wallet address, get its
   delegations, rewards, and validator health. Opt in to alerts for validators going inactive,
   raising commission, or going dark for 24h+, and for unexpected unstakes on a watched address.
   Read-only, public, holds no keys.
2. **Guardian rescue** (`contracts/`, `rescue-cli/`) — while the wallet is still safe, the user
   delegates their EOA to their own rescue contract instance via an EIP-7702 authorization and
   commits a fixed safe address. If the wallet is later compromised, a guardian triggers the
   rescue, and the contract can only move funds to that pre-committed address.

## What it does not do, stated plainly

MonRescue **cannot** protect a wallet from someone who holds its seed phrase. That is not a
limitation of this implementation; it is what holding the seed means. Specifically:

- The attacker can submit a new EIP-7702 authorization re-delegating the EOA to their own
  drainer, or clear ours, or simply transfer liquid MON.
- Our advantage is **speed, pre-staging, and surprise** — not authorization exclusivity.
- The defensible case is **staked and unbonding MON**, where the protocol's own unbonding delay
  means the attacker must wait too. Liquid MON against an alert attacker is a coin flip and we
  do not claim otherwise.

The only design that genuinely defeats a live seed holder is a smart account with a withdrawal
timelock and a guardian veto — a migration, not a retrofit. It is on the roadmap, not in this
repository.

### MonRescue will never ask for your seed phrase or private key

There is no code path in this repository that accepts one, and there never will be. The only
things a user ever produces are two signatures made in their own wallet: the 7702 authorization
and the pre-signed rescue payload. Anyone asking a compromised user for a seed is robbing them.

## Layout

```
packages/shared/   staking precompile ABI + address, chain config, reserve and epoch logic
contracts/         MonRescue.sol — destination-locked rescue contract
watcher/           alert engine + Telegram bot          (ship first)
rescue-cli/        guardian hot path: pre-sign, arm, fire
research/          Phase 0 harness + FINDINGS.md        (the design record)
```

The staking ABI and precompile address live in exactly one place (`packages/shared`) and are
never duplicated.

## Monad-specific constraints this encodes

Three things make an Ethereum rescue tool wrong on Monad. Each is verified and encoded:

1. **No private mempool, no bundle relay.** Atomicity comes from an EIP-7702 batch call, not a
   Flashbots bundle. Ordering is a priority gas auction against leaders, so the hot path
   broadcasts to every RPC at once and bids the fee up.
2. **The 10 MON reserve rule.** A 7702-delegated EOA reverts any transaction ending below
   `min(balance at start, 10 MON)`. Note this is *not* a flat 10 MON — a wallet already drained
   to zero can be swept in full. Encoded in `packages/shared/src/reserve.ts`.
3. **Epoch-bound unbonding, with no computable unlock block.** Rounds advance independently of
   blocks, so the boundary cannot be predicted arithmetically. The trigger is a polled
   `getEpoch()` transition.

## Verify the research claims yourself

No key required — this checks the live chain against every factual claim in `FINDINGS.md`:

```bash
pnpm install
pnpm --filter @monrescue/shared build
CHAIN_ID=10143 pnpm --filter @monrescue/research verify
```

To close the remaining gate you need a funded testnet key (see `.env.example` at the repo root), then
run scripts A→D. Each writes its transaction hashes to `research/artifacts/`.

## Build

```bash
pnpm install
pnpm --filter @monrescue/shared build
pnpm -r typecheck
```

The contract builds with Foundry (`forge build` in `contracts/`). It was verified during
development with `solc` 0.8.36 directly, since Foundry could not be installed in the build
environment.

## License

MIT. See [LICENSE](LICENSE).
