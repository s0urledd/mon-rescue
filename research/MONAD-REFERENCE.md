# Monad reference — facts that shape this project

A durable record of what was read from `docs.monad.xyz`, kept in-repo so the design does not
have to be re-derived and so claims stay checkable. Everything here is quoted or paraphrased
from the official documentation; things measured on-chain live in `FINDINGS.md` instead.

Read alongside `FINDINGS.md` (empirical results) and `STRATEGY.md` (what we do about it).

---

## 1. Network

| | Mainnet | Testnet |
|---|---|---|
| Chain ID | **143** | **10143** |
| Client (Aug 2026) | `Monad/0.15.1` | `Monad/0.15.2` |
| Explorers | monadvision.com, monadscan.com | testnet.monadvision.com |
| Faucet | — | faucet.monad.xyz |

Mainnet launched **24 Nov 2025**. Testnet was reset from genesis on **2025-12-16**.

Public RPC endpoints carry different limits — `eth_getLogs` block range is **100** on
QuickNode (`rpc.monad.xyz`) and Monad Foundation (`rpc-mainnet.monadinfra.com`), **1,000** on
Alchemy (`rpc1`, also capped at 10,000 logs) and Ankr (`rpc3`).

---

## 2. Timing and consensus

| Quantity | Value |
|---|---|
| Block time | **300 ms** |
| Speculative finality | 1 slot (**300 ms**), `Voted` |
| Full finality | 2 slots (**600 ms**), `Finalized` |
| State-root finality | `Verified`, ~3 blocks after finalized (T+5) |
| Execution lag behind consensus (`k` = `D`) | **3 blocks** (docs say ~1.2 s) |
| Epoch | 50,000 blocks (`BOUNDARY_BLOCK_PERIOD`) |
| Epoch delay after boundary block | 5,000 **rounds** (`EPOCH_DELAY_ROUNDS`) |
| Active validator set | 200 |

**Rounds are not blocks.** "Upon a failed block proposal (e.g. timeout), the round increments
while the block does not." This is why epoch boundaries cannot be computed exactly from block
height — though see `FINDINGS.md` Q6, where measurement shows the boundary block *is* exactly
`(epoch-1) × 50,000` and the flip lands within 5,000 blocks of it.

Block states: `Proposed` → `Voted` → `Finalized` → `Verified`, mapping to the RPC tags
`latest` → `safe` → `finalized`. **`pending` behaves the same as `latest`.**

The **leader schedule is deterministic and known for a whole epoch in advance** — each
validator computes it from locked stake weights at epoch start. Stake weights lock one epoch
ahead.

---

## 3. Asynchronous execution — the root of most Monad-specific behaviour

> "In Monad, nodes come to consensus … without ever executing those transactions."

The proposer builds a block against state from **3 blocks ago**. Three consequences that matter
to us:

1. **A leader cannot filter out a transaction that will revert**, because it does not execute
   it. Reverting transactions are included and charged. (Verified empirically — see
   `FINDINGS.md`.)
2. **`eth_call` runs against speculative `Proposed` state**, which is *newer* than the lagged
   state the proposer validates against. This asymmetry is exactly what produces
   "simulated fine, reverted on chain".
3. **A newly funded account cannot spend for `k` blocks.** "Newly-funded accounts which
   previously had zero balance cannot send transactions until the transfer that credits them
   is `D` blocks old." Relevant when funding a guardian just in time — don't.

Parallel execution is invisible to contracts: results commit serially, so the outcome is
identical to serial execution. It needs no special handling.

---

## 4. Gas — three differences that cost real money

**Gas is charged on the gas LIMIT, not gas used, and there are no refunds.**

> "In Monad, the gas charged for a transaction is the gas limit set in the transaction, rather
> than the gas used in the course of execution." → `gas_paid = gas_limit * price_per_gas`

A generous limit is money burned on every attempt, including reverted ones. It also inflates
the base fee (the controller sums gas *limits*) and consumes the inflight budget below.

| Parameter | Value |
|---|---|
| Minimum base fee | **100 MON-gwei** |
| Block gas limit | 200M (docs inconsistent: `summary.md` says 150M — read it from headers) |
| Per-transaction gas limit | 30M |
| Base fee target | 160M (80% full) |

**Ordering is a Priority Gas Auction on total gas price (base + priority), descending** — but
it is *default client behaviour and leader discretion*, not a consensus rule.

**`eth_maxPriorityFeePerGas` returns a hardcoded 2 gwei**, not a live recommendation. Any fee
oracle must be built from observed included transactions.

Repriced opcodes: cold account access **10,100** (vs 2,600), cold storage access **8,100**
(vs 2,100); warm access unchanged at 100. `ecRecover` doubled to 6,000. Memory expansion is
linear (`w/2`) with an 8 MB per-transaction cap.

---

## 5. Reserve balance (MIP-4) — the per-account throughput ceiling

Two separate rules, often conflated:

**At consensus time**, for each account, the sum of `gas_price × gas_limit` across all
*inflight* transactions (included less than `k=3` blocks ago) must satisfy

```
sum(gas_fees) <= min(10 MON, balance at block n-k)
```

Note the balance is the **lagged** one — topping an account up does not raise the ceiling for
~3 blocks. **This, not RPC rate limits, is the real cap on how many attempts can be in flight.**

**At execution time**, a non-sender account's ending balance must not be lower than
`min(balance at transaction start, 10 MON)`; for the sender it may be lower by at most the gas
spend.

The **emptying exception** lets an *undelegated* sender dip below the reserve, but only if it
has sent nothing for `k` blocks and no delegation/undelegation request touched it in that
window. **Delegated EOAs cannot use it.**

> Caution: the EIP-7702 page states the rule more strictly — "transactions that would reduce
> its balance to below 10 MON will unconditionally revert." That contradicts the
> `min(start, 10 MON)` formulation for an account starting below 10 MON. `FINDINGS.md` Q3
> tracks this as UNVERIFIED; Script C settles it.

Detection: reserve precompile `0x1001`, `dippedIntoReserve()`, selector `0x3a61584e`, 100 gas,
**must be invoked via `CALL`** — `STATICCALL`/`DELEGATECALL`/`CALLCODE` revert.

---

## 6. Transaction propagation — there is no global mempool

1. A transaction goes to the RPC process of an **owner node**.
2. Static checks, then dynamic checks (balance, nonce) against local MonadDb state.
3. The node forwards to **`N = 3` upcoming leaders** — one hop, over UDP via RaptorCast, no
   gossip and no rebroadcast.
4. Each leader inserts it into its **local** mempool.
5. If not included within `N` blocks, the owner node re-sends to the next 3 leaders, up to
   **`K = 3`** times total.

Eviction: pruned on finalization; evicted when invalid (nonce too low, insufficient balance);
oldest evicted when the mempool hits a soft limit.

**Consequences for a race:** targeting a specific block means targeting a specific *leader's*
mempool, and the schedule is by round rather than block. After ~9 leader slots the owner node
stops retrying — resubmission is ours to implement.

**Nonce gaps are tolerated.** The FAQ is explicit: submit nonce 3, then 0/1/2, and 3 still
executes. Inclusion requires contiguity, but a gapped transaction is held rather than dropped.
This is what makes a multi-nonce spray viable.

**No pending-transaction visibility.** `eth_getTransactionByHash` returns `null` for a
mempool transaction, and `newPendingTransactions` is unsupported. Monad provides
`txpool_statusByHash` and `txpool_statusByAddress` instead.

**Transaction replacement is completely undocumented** — no minimum fee bump, no same-nonce
policy, no replacement error code. With no global mempool, a replacement may not even reach
the leader holding the original. Treat any replacement strategy as unverified.

---

## 7. EIP-7702

Type `0x04` is supported with the Ethereum workflow. The authorization "can be submitted by the
EOA themselves, **or by anyone else** … This will allow EOAs to behave like smart contracts
without any funds for gas!" — which is why a compromised account needs **zero MON** for us to
rescue it.

Delegation indicator is `0xef0100 ‖ address`, publicly readable via `eth_getCode`. It persists
until another `0x04` changes it; delegating to the zero address clears it.

Monad-specific restrictions:

- A delegated EOA's balance cannot dip below the reserve floor (§5).
- **`CREATE`/`CREATE2` are banned** in delegated code, specifically to keep the EOA's nonce
  statically predictable.
- **Delegating an EOA to a Monad precompile bricks it** — "all calls to it will revert".

Canonical `Simple7702Account` on mainnet: `0xe6Cae83BdE06E4c305530e199D7217f42808555B`.

---

## 8. Staking precompile — `0x0000000000000000000000000000000000001000`

A precompile, not a contract: `eth_getCode` returns empty, its account is always warm, and
**calls with invalid arguments consume all forwarded gas** (so always cap gas on a speculative
call). **Only `CALL` is allowed** — which is why every "view" is declared `nonpayable`.

Key signatures (full ABI in `packages/shared/src/staking.ts`):

```solidity
function delegate(uint64 validatorId) external payable returns (bool);
function undelegate(uint64 validatorId, uint256 amount, uint8 withdrawId) external returns (bool);
function withdraw(uint64 validatorId, uint8 withdrawId) external returns (bool);
function claimRewards(uint64 validatorId) external returns (bool);
function getEpoch() external returns (uint64 epoch, bool inEpochDelayPeriod);
```

**No fund-moving function takes a recipient.** Payout is always to `msg.sender`. This single
fact drives the whole rescue architecture — see `FINDINGS.md` Q5.

Constants: `WITHDRAWAL_DELAY` 1 epoch, `DUST_THRESHOLD` 1 gwei, `MIN_AUTH_ADDRESS_STAKE`
100,000 MON, `ACTIVE_VALIDATOR_STAKE` 10,000,000 MON, `MAX_COMMISSION` 1e18, `REWARD` 18
MON/block, `PAGINATED_RESULTS_SIZE` 100.

Events include `Delegate`, `Undelegate`, `Withdraw`, `ClaimRewards`, `CommissionChanged`,
`ValidatorStatusChanged`, `EpochChanged(uint64,uint64)`, `ValidatorRewarded`.

Uptime and jailing are **not** in the staking docs; "automated in-protocol slashing is not
currently implemented". Validator health has to come from `flags` plus an external source.

Other precompiles: all Ethereum precompiles through Fusaka (`0x01`–`0x11`), P256 verification
at `0x0100` (EIP-7951), staking at `0x1000`, reserve balance at `0x1001`.

---

## 9. Execution Events — the lowest-latency data path

The most important operational finding for a latency-critical tool.

Monad's execution daemon publishes EVM actions into a **shared-memory ring buffer** (mmap'd,
normally on hugetlbfs). Consumers poll it directly.

> "This is the fastest way to consume real-time data."

The decisive structural argument: **the RPC server is itself an execution-events consumer.**
Polling `eth_call` cannot be faster than the ring, because it goes *through* a ring consumer and
adds an RPC hop, JSON encoding, a loopback round-trip, and poll-interval quantisation.

| Source | Granularity | Published when |
|---|---|---|
| Standard `newHeads` / `logs` | block | block reaches **`Voted`** |
| `monadNewHeads` / `monadLogs` | block | block reaches **`Proposed`** (~1s earlier) |
| **Execution events SDK** | **per transaction** | **as soon as the proposal is received** |

Latency figures the docs do give: events are recorded **under one microsecond** after the
action they describe; the consumer runs "about one microsecond later" in a separate process;
`BLOCK_START` precedes the first transaction event by about **1 ms**.

**For our epoch trigger there are two paths, and the better one is not the obvious one:**

- **`BLOCK_START.epoch`** — the `monad_exec_block_start` payload carries `round` and `epoch`
  directly. Watching for a change is a 64-bit compare on a hot cache line, needs no transaction
  decoding, and arrives ~1 ms before any transaction event in the block.
- **`TXN_LOG` filtered** on `address == 0x…1000` and `topic[0] == keccak("EpochChanged(uint64,uint64)")`
  — authoritative, slightly later.

The docs never state that the consensus epoch in `BLOCK_START` changes in the same block as
`syscallOnEpochChange` updates precompile state, so **Path A must be validated on our own node
before being relied on.**

Requirements: an ordinary **full node** (not validator-only), **Linux**, the consumer on the
**same host**, and the daemon started with `--exec-event-ring …` — which is **not** in the
default configuration. APIs are **C, C++ and Rust only**; there is no TypeScript binding, and
at a ~10 µs per-event budget an FFI layer would likely cost more than it saves.

Two operational traps: the sample loop sleeps 10 ms on `NotReady`, which reintroduces exactly
the sampling error we are trying to remove — spin instead; and the ring's `schema_hash` is
checked at startup, so a node upgrade can hard-fail the consumer with `EPROTO` until it is
recompiled against the matching header. That failure is loud, not silent, which is the right
trade.

**Read-only.** There is no shared-memory submission path; sending stays on normal RPC. The ring
makes the *signal* fast, not the send.

The docs explicitly endorse our pattern: pre-sign while waiting on speculative data, then
"pull the trigger" on the signal, accepting that a small fraction of speculative blocks are
abandoned.

---

## 10. RPC quirks worth knowing

- **Unsupported:** EIP-4844 blob transactions (type 3), `syncing` and `newPendingTransactions`
  subscriptions.
- **Monad-specific methods:** `eth_sendRawTransactionSync(hex_tx, timeout_ms)` returns the
  receipt directly instead of requiring a poll loop; `txpool_statusByHash`,
  `txpool_statusByAddress`; `monadNewHeads` / `monadLogs` subscriptions.
- **Deferred validation:** `eth_sendRawTransaction` may accept a transaction with a nonce gap
  or insufficient balance, because it may become valid by block-creation time. Acceptance is
  not a guarantee of inclusion.
- **`eth_call` gas pools:** requests are routed by gas limit — **≤ 8,100,000** goes to a
  high-throughput pool, above that to one with only ~20 concurrent slots. Keep simulation gas
  limits under 8.1M.
- **Historic state is limited.** Every full node is an archive node only as far as disk allows —
  roughly 40,000 blocks (~3.3 hours) on a 2 TB SSD. `eth_call` at older blocks fails.
- **Speculative subscriptions carry `blockId` and `commitState`.** The same block emits several
  updates as it advances, `Voted` may be skipped, and **there is no abandonment event** — a
  losing proposal is silently superseded when a different `blockId` finalizes at the same
  height. Consumers must dedupe by `blockId` and detect abandonment themselves.
- `TIMESTAMP` is second-granularity, so 3–4 consecutive blocks share a timestamp. Never use it
  to order or deduplicate blocks.

---

## 11. Node-operator advantages

Documented ways to get closer to the data (all on the receive side; nothing accelerates
submission):

- **Prioritized secondary RaptorCast** — a validator can whitelist a full node so it is always
  invited to that validator's block-delivery group, bypassing peer discovery.
- **Dedicated upstream / chunk forwarding** — a validator forwards all primary RaptorCast
  chunks directly to a named full node.
- **Execution events on a co-located node** — the fastest documented path (§9).

There is **no** documented leader-direct submission endpoint, private mempool, priority lane, or
bundle relay. Monad's validator delegation policy actively discourages third-party order-flow
routing and external block builders, so a Flashbots-equivalent is unlikely to appear soon.

---

## Sources

All pages fetched from `docs.monad.xyz` (raw markdown via the `.md` suffix) during Phase 0,
August 2026: `developer-essentials/` (differences, transactions, gas-pricing, opcode-pricing,
reserve-balance, eip-7702, precompiles, network-information, testnet, best-practices,
wallet-developers, historical-data, summary), `reference/staking/` (overview, api),
`reference/json-rpc/` (overview, api), `monad-arch/` (consensus/local-mempool, monad-bft,
staking, asynchronous-execution, block-states, raptorcast, transport-protocols,
execution/parallel-execution, realtime-data/spec-realtime, realtime-data/data-sources),
`execution-events/` (index, overview, event-ring, consensus-events, advanced, c-api, rust-api,
getting-started/*, release-notes), `node-ops/` (events-and-websockets, full-node-block-delivery,
validator-delegation-program/mev), and `faq`.
