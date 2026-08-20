# MonRescue — working context

Read this first. It carries the framing that is expensive to rediscover.

---

## What this is

A **commercial rescue service** for Monad delegators, private repo, not open source. A user
whose key is compromised comes to us; we recover their staked or unbonding MON to an address
only they control.

Not a public good, not a hackathon submission, not a demo. Prose in this repo is for us, not for
an audience. Do not write outward-facing narrative, grant framing, or PR bodies aimed at
strangers.

## The framing — everything else follows from this

**Assume the adversary is always trying to take it before us, and always will be.** A hostile
withdraw is not a scenario to plan for; it is the default state. There is no version of this
where the other side is slow, distracted, or absent, and any design that quietly depends on
that is wrong.

The goal is therefore not "fast enough". It is **the fastest system that can be built** — and
where speed ties, the one that outbids.

Two corollaries that keep getting rediscovered the hard way:

- Never set a default for frugality on a path where being short loses the position.
- Never treat "probably uncontested" as a reason to do less. We cannot know it is uncontested,
  and by the time we could, it is decided.

## The threat model, precisely

The attacker **holds the seed**. They are cryptographically indistinguishable from the owner.
That is not a caveat — it is the whole problem.

- **Liquid MON is not defensible.** A seed holder takes it in one block. Do not claim otherwise.
- **Staked and unbonding MON is defensible**, because `undelegate` puts funds behind
  `WITHDRAWAL_DELAY` for *everyone*, including the attacker. That delay is the entire product.
- The attacker usually unstakes themselves. Their `Undelegate` event hands us the validator, the
  slot, the amount and the exact maturity epoch — the theft starting is our clock starting.
- The fight is at the **unlock**, and both sides know when it is.

**Nobody registers before being hacked.** The primary flow is reactive: the user arrives already
compromised. The unbonding delay (2–3 epochs, 8–13h) is what makes that survivable.

**Two arrival states, both covered.** The attacker may not have touched the Monad position yet —
a wallet is often drained on another chain first, and that is when the user notices. So:

| on arrival | what we do |
|---|---|
| already unbonding | arm for the maturity epoch we read off their `Undelegate` |
| still actively staked | `startUnbonding()` ourselves, then arm |

Do **not** wait for the attacker to unstake when the stake is still active. Waiting hands them
three choices that are ours to take: **the moment** the contested block falls, **the slot count**
(each slot needs its own `withdraw()`; 256 of them puts one attempt at ~35 MON against a
`min(10 MON, balance)` inflight cap and collapses the spray to a single shot), and **the
boundary** (before it activates at n+1, at or after it n+2 — a full epoch, ~4.2h).

## The one thing that must never break

`SAFE_ADDRESS` is immutable, set at construction, one contract instance per user. **No function
anywhere takes a recipient address.** Even an attacker calling `rescue()` moves funds to the
user's own safe address.

This is why `rescue()` and `sweep()` are permissionless: access control on a destination-locked
function buys nothing and costs liveness.

We never accept a seed phrase or private key. There is no code path that could. The user's only
input is signatures made in their own wallet.

---

## Measured facts — do not re-derive these

| Fact | Value |
|---|---|
| Boundary block | exactly `(epoch - 1) × 50,000` |
| Epoch begins | 4,962–4,999 blocks after the boundary |
| Block time | 0.301s → epoch ≈ 4.2h (docs say 5.5h; wrong) |
| Epoch advances in | **transaction 0** of the flip block (`syscallOnEpochChange`) |
| `withdrawEpoch` | the **activation** epoch (`n+1`, or `n+2` past the boundary) |
| Maturity | `withdrawEpoch + WITHDRAWAL_DELAY` |
| `withdraw()` gas | exactly **68,675** |
| `gasUsed` in a receipt | **always equals the limit** — carries no information about consumption |
| Sender's gas allowance | `gas_price × gas_limit` (docs, verbatim) |
| Failed precompile call | *"calls with invalid arguments consume all gas"* — a cap above the tx limit caps nothing |
| Cold account access | **10,100 gas** (Ethereum: 2,600). Cold storage 8,100 (2,100). Warm unchanged |
| Memory expansion | linear `w/2`, not Ethereum's quadratic |
| Inflight gas budget | `min(user_reserve_balance, lagged balance)` over `k` blocks — docs confirm |
| 7702-delegating **to the staking precompile** | *"all calls to it will revert"* — never do this |
| Authorization list length | capped at **4 or 5** (6 rejected, 4 accepted). Undocumented, RPC-enforced |
| `claimRewards()` gas | 155,375 — **70% of per-position cost**, usually not worth it |
| Sweep to an EOA | ~0 gas |
| Precompile payout | **raw balance credit, not a CALL** — recipient code does not run |
| Reserve floor | `min(balance at start, 10 MON)` — applies to **every** EOA, not just delegated ones |
| Emptying exception | the only way below the floor; needs **undelegated** + `k=3` quiet blocks. Our delegation closes it |
| Value a delegated account may send | `balance − min(balance, 10 MON)` — **zero below 10 MON**, gas only |
| Mainnet base fee | pinned at the 100 gwei floor |
| Mainnet tips | p50 **2 gwei**, p90 78, **max observed 1,482** |
| Detection latency | ~8ms local node, ~116ms remote RPC |

Full evidence with transaction hashes is in `research/FINDINGS.md`. Every claim there was
executed against live chain, not read from documentation.

**Phase 0 is closed.** Q1 (atomic claim + sweep) is answered YES — tx `0x6c285d49…`, block
51,416,783, 500.112413 MON delivered in one block by a guardian that never held the victim's key.

---

## Design decisions and why

**Gas is charged on the LIMIT, not usage, with no refunds.** Being short is fatal — the staking
precompile consumes all gas on failure, so an under-sized limit loses the whole attempt at full
cost. Being long only costs the difference. `estimateRescueGas()` sizes from position count.

**Fees are a MON budget per attempt, not a multiplier.** `eth_maxPriorityFeePerGas` returns a
hardcoded 2 gwei on Monad, so a multiplier over it scaled a constant that measured nothing.
`observeFees()` samples real bids.

**The window is priced flat, well above the average — not above the outlier.** Every window
attempt could be the one in the flip block, so they all bid the same; a ramp just randomises
what we pay at the decisive block. The anchor is `p90 × 10`: hundreds of times the median, and
a full window lands at **10–20 MON** on observed mainnet traffic. Anchoring on the observed
*maximum* was tried and took the window to 93 MON, which prices the uncontested majority off a
single outlier. Escalation rungs handle a genuine top bidder, and only fire after the window
failed — the first real evidence anyone is racing. Operator's ceiling: 100–200 MON is
acceptable, 10–20 is the target. **Minimum gas is never the priority.**

**Pre-queue by default when waiting for a flip.** The epoch advances in tx 0 of the flip block,
so a transaction already in a leader's mempool lands in that block; reacting reaches only N+1.
Costs ~2 MON, can only win a block, never loses one.

**Run beside a local node.** Detection latency is bounded purely by the round-trip of whatever
we poll. Reads and broadcast both go local first, remotes behind as failover.

**One guardian key per concurrently-armed customer.** Monad's inflight gas cap is per account and
belongs to the guardian; two customers maturing in the same epoch would split one
`min(10 MON, balance)` budget. Guardians choose nothing, so a pool carries no custody risk.

---

## The recurring mistake — check for it

**Five times** a default was set for frugality on a path where being short is fatal and being
long merely costs money:

1. A 350k gas limit that lost an entire rescue attempt
2. A fee multiplier that scaled a constant
3. Defaulting away from pre-queuing to save ~2 MON
4. One broadcast every 3 blocks — covering a third of the flip window, so two times out of
   three the flip block found nothing of ours queued and we reacted after all. Paying the
   spray's full cost for a third of its benefit.
5. `GAS_LIMIT=350000` in `.env`, silently overriding `estimateRescueGas()`. It sat below the
   contract's own 400,000 gas cap, so the cap capped nothing, a failing `withdraw()` ate the
   whole transaction, and `_sweep()` never ran. **This lost the epoch 1035 battle test** — all
   63 attempts and the backstop reverted with `out of gas` before any race was run.

The operator has said plainly that cost is not the constraint. **Optimise for winning.** When a
default trades a small certain cost against a small chance of total loss, take the cost.

## The other recurring failure class

Five separate failures, all **silent**, none logic errors in the ordinary sense:

- a stale `dist/` that died on import and looked identical to "armed and waiting" for two days
- a log lookback sized for prompt claims, missing a two-day-old position
- a relative path resolving differently per package under `pnpm --filter`
- a budget exceeding the guardian balance, aborting instead of scaling
- `spray()` backing off with `continue` inside a `for…of`, which **skipped** the attempt instead
  of delaying it — and since attempts carry consecutive nonces, the first back-off stranded every
  later rung behind a permanent nonce gap

Every one would have lost funds in a real rescue and none announced itself. The last was the
first caught before it cost anything, by reading the hot path asking *"what does this do when the
guard fires?"* — the guarded path is where the damage lives, and it is the path no happy-path
test exercises.

`nohup` is not supervision. Production needs `systemd` with `Restart=always` and a heartbeat
visible from **outside** the process — a process that is not running cannot report that it is
not running.

---

## Open items

- **Slot-splitting griefing.** Each withdrawal slot needs its own `withdraw()` call, and the
  attacker chooses how many `undelegate` calls to make. 50 slots multiplies our per-attempt cost
  13x; at the 256 maximum one attempt costs ~35 MON and collides with the inflight budget,
  collapsing the spray to a single shot. Likely fix: split the rescue across transactions.
- ~~Ladder escalates by attempt index~~ **fixed.** Window attempts are now priced flat, because
  any of them can be the one in the flip block; escalation begins only after the window closes,
  where the epoch has flipped by definition and a failure is real evidence of a contest. The
  window fee anchors on p90 (×10), not the max observed bid — 10x an outlier across ~60 window
  attempts costs ~98 MON to cover a window that is usually uncontested.
- **Anti-revoke is proven (Q25).** `test:antirevoke` (isolated, ~1 min): attacker re-delegates the
  victim to their drainer, our `sweep()` carries one `window.json` authorization, the
  authorization re-asserts our delegation before the call, `sweep()` runs our code, funds reach
  the safe. PASS. Property of authorization-before-call ordering, not a race. **Emergent bonus:**
  in the live epoch 1053 spray our authorization applications climbed the victim nonce ~0.7/block
  and *starved* the attacker's single flip-time re-delegation (it never mined) — a favorable but
  contingent observation against a non-adaptive attacker, not a guarantee.
- **First contested win landed at epoch 1046 (Q24).** Equal fee (45 gwei), equal strategy, naive
  attacker: safe +500.48 MON, attacker 0. The epoch-1040 completion-bar fix worked live — a
  premature 400 MON loose sweep stayed under the position-sized bar, so the spray kept going and
  claimed the position at the flip. **Honest limits:** the attacker's zero was from losing the
  race, NOT the destination lock (their withdraws all reverted after ours, so nothing ever
  landed for the lock to redirect); `window.json`'s anti-revoke was carried but never exercised
  (naive attacker didn't re-delegate); the atomic attacker and the both-in-flip-block auction are
  still unmeasured. Prior runs: epoch 1035 lost to a gas cap above the tx limit (Q19), epoch 1040
  to a 1-wei completion bar (Q20).
- **A premature attempt is not a no-op.** It sweeps everything above the reserve floor, which is
  correct and is *progress*, not completion. Any success test must be sized against the position
  (`totalAmount`), never against "did the safe balance move".
- **Giving up is now bounded, not automatic.** A reverted backstop used to exit the process. It
  now retries while any slot still holds a withdrawal request and the guardian can afford a
  shot, because `rescue()` sweeps regardless of whether the withdrawals succeed — so a revert
  means the money has not arrived *yet* at least as often as it means it is gone.
- **The mirror-design atomic attacker is measured — and it WINS at parity (Q28). The honest ceiling.**
  Prior atomic wins beat an attacker draining *from the victim account*, so we starved its nonce
  (Q27, epoch 1071: safe +116.15, attacker 0). The mirror twin removes that mistake — it **sponsors**
  the drain (sponsor's nonce, immune to our bumping) and **marches its own victim-authorizations**
  across a range, exactly as we do. Epoch 1076, equal fee (45 gwei), equal coverage (100%), equal
  infra, verified on-chain: **total loss** — attacker sink **+115.007 MON** (100 position + ~15
  loose), safe **+0**, victim swept to the 10 MON floor. At parity the flip block is winner-take-all
  on `withdraw()` ordering — a coin flip — and **we hold no structural edge.** The destination lock
  bought nothing (the attacker owned the delegation at the decisive block → funds flowed through
  *their* contract to their sink); nonce-starvation does not apply to a sponsored drain; anti-revoke
  re-delegated us back but *after* the slot was emptied. **This kills "we always win" permanently.**
  Untouched by this test: **outbid** (fee ladder to the 100–200 MON ceiling) and **infra/latency**
  (both were localhost) — the actual product — plus the field being ~97% naive sweepers we beat live
  (Q24, Q27). N=1: proves the tails side exists, not its probability. **The outbid test has since run
  (Q29) — it did not help.**
- **Outbidding 3× does NOT recover it — the real fight is the anti-revoke nonce race, not the fee (Q29).**
  Rebuilt position, epoch 1097, everything symmetric except fee: arm **135 gwei** vs attacker **45**
  (exactly 3×), both off the same p90=3. Verified on-chain: **arm lost again** — safe **+4.95** (loose
  only), sink **+100** (position), victim at the 10 MON floor. Why the 3× was moot: the attacker's
  marching sponsored re-delegations advanced the **victim nonce ~7/block** (367→387); arm's anti-revoke
  selects its per-attempt slice as `startupNonce + i` (anchored at startup, +1 per attempt), so the
  early attempts that actually broadcast carried nonces already consumed — **stale, silently skipped** —
  and arm's `rescue()` ran the attacker's **drainer** code. **A fee that orders you first is worthless
  if your tx runs the attacker's code.** Fee wins ordering (Q7 PGA is real); it does not win *this* race,
  which the delegation-at-execution decides — and the attacker takes that by nonce-racing. **The lead
  (unproven):** the window was wide enough (322..388 covered the live 367–387); the *selection* was
  mis-anchored. Selecting auths by the **live** nonce could let the 3× fee win — but sequential guardian
  nonces + the 4-auth cap (Q22) block the naive fix; it needs **one fresh flip-time signature**
  (live-nonce auth, next guardian nonce), a hot-path trade against pre-signing. Whether that beats a
  *continuously* racing attacker is **the single most important open question now.**
  **FIX IMPLEMENTED (UNVERIFIED until a live re-test).** arm no longer bakes the auth slice into
  pre-signed bytes at `startupNonce + i`. When a window is loaded, each spray attempt (and the
  backstop) now **signs JIT at broadcast**, choosing the slice against the **live** victim nonce read
  at that moment — `selectAuthorizations` already returns a forward spread (`AUTHS_PER_ATTEMPT`, the
  4-auth cap) that tolerates a few steps of drift. Guardian nonces stay fixed and sequential; only
  the auth slice is chosen late, and the JIT read+sign is a ~ms spread across the window, nowhere near
  the flip instant, so the pre-sign latency principle holds. `selectLiveAuths()` falls back to the
  startup nonce if the live read hiccups, so it never throws and never strands a guardian nonce behind
  a gap. `DEBUG_AUTH=1` logs the selected victim-nonce range per attempt, so a re-test can confirm the
  auth nonce climbs *with* the attacker's racing instead of lagging it.
  **FIX VERIFIED — it WON the position (Q30).** Epoch 1106, same mirror-atomic attacker, 1.8× outbid:
  safe **+100.22 MON (the position)**, attacker sink **+19.95 (only the loose)**, victim at the floor.
  The live-nonce authorization tracked the racing nonce, so `rescue()` ran OUR code (not the drainer)
  and swept the position to the safe — Q28/Q29's exact loss, flipped. The loose going to the attacker
  is fine: it is liquid and undefendable; the staked position is the win. **N=1 win vs N=2 pre-fix
  losses** — strong signal, not proof of always-win. The open frontier is a *continuously* racing
  attacker that outruns the 4-auth forward spread between arm's live read and the block.
- **Completion detection: size success against the POSITION, never loose + position (Q30).** The win
  above was first reported as a FAILURE (`succeeded=false`, "funds left without us", exit 1) because
  `doneThreshold` was `loose + 90%·position` and a position-only win (attacker took the loose)
  delivered less than that. Fixed: `doneThreshold = 90%·position` alone, and `isDone()` also requires
  the position slot to be empty so a large loose sweep with the position still pending can't
  masquerade as a win. No funds were at risk — it was a false alarm — but in production a false
  "failure" triggers wasted retries and operator panic. The loose is undefendable; never make
  rescuing it a condition of success.
- **viem `executor: 'self'` does NOT tie the auth nonce to your tx nonce** — it fetches its own at
  `blockTag: 'pending'`. Always pass the authorization nonce explicitly as `txNonce + 1`. A silent
  skip here writes `status: success` while nothing ran (Q23).
- **Boundary A/B contrast unmeasured.** `n+1` activation is confirmed; `n+2` is predicted from
  the same rule but never observed.
- **Same-nonce replacement is undocumented on Monad.** Do not build on it.
- **The "sophisticated" attacker is the ordinary one.** ~97% of EIP-7702 delegations on mainnet
  four weeks after Pectra pointed at copy-pasted sweeper contracts (Wintermute, "CrimeEnjoyor").
  Assume an arriving victim is already delegated to hostile code.
- ~~Is the payout a CALL or a raw credit?~~ **SETTLED: raw credit** (Q21). Recipient code does
  not run, so a sweeper-delegated attacker gets no atomic drain and still needs a second
  transaction. Verified against `claimRewards` with a working positive control; re-confirm
  against `withdraw()` on the next matured slot.

---

## Conventions

- Commit messages: what changed and why, no marketing. End with the Co-Authored-By trailer.
- Never commit `.env`, `window.json`, or any key.
- Mark anything unverified as UNVERIFIED and say so out loud. A rescue tool that oversells
  itself is worse than none.
- When a measurement contradicts a documented claim, **the measurement wins** and the
  contradiction goes in FINDINGS.
- Run scripts rebuild `@monrescue/shared` first — a stale `dist` has already cost one rescue.
