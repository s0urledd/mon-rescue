# FUAA — strategic read and product evolution

*For us. Written 2026-08-26, the week the proposal landed. This is analysis, not a commitment;
re-read it against the actual implementation spec when that lands, because the mechanics that decide
whether we live here are exactly the ones the draft defers.*

---

## What FUAA is

**Flexible and Upgradeable Account Authentication** — a Monad Improvement Proposal published
2026-08-22/24 by **Kushal Babel** (Cornell PhD, now Monad Labs) and **Jan Camenisch** (a serious
cryptographer — anonymous-credentials lineage, ex-IBM/DFINITY). Picked up by CoinDesk, crypto.news,
CryptoTimes the same week, so it has visibility, not just a forum thread. **Status: Draft v1
(design + architecture); concrete implementation spec deferred.** Protocol changes of this scope
(new tx type + state-trie field + `AuthConfigManager` precompile + consensus-side validation) slip,
and drafts move. Treat "ships in months" as optimistic and load-bearing on nothing.

The essence, in one line: **separate an account's authentication from how its address is derived.**
An account holds a mutable `AuthConfig` (a set of authenticators + a declarative policy over them,
`ID(i) | THRESHOLD(k, [...])`); the 20-byte address is fixed at genesis and does **not** move when
keys are added, rotated, retired, or upgraded. That buys, natively:

- **Recovery** from a lost/compromised key without moving assets (guardians are just a clause of the
  `reconfiguration_policy`).
- **In-place scheme upgrade**, including **post-quantum** (ML-DSA) and **passkeys** (WebAuthn/P-256).
- **Protocol-enforced multi-factor / scoped** policies.

Reconfiguration goes through the `AuthConfigManager` precompile, requires satisfying the account's
`reconfiguration_policy` **plus proof-of-possession of every authenticator being installed**, and
**activates `k` blocks later (k=3 today)**. At most one pending configuration at a time.

This is not a wallet feature. It is the protocol absorbing **our exact problem domain** — key
compromise and recovery — as a first-class primitive.

---

## Why it matters to us (the honest threat)

1. **It absorbs our function.** FUAA's own motivation section is our pitch verbatim: *"compromise of
   the key compromises every asset… a lost key makes the account unrecoverable."* When a protocol
   makes your service's job a native primitive, the third-party wrapper usually either dies or moves
   up-stack. We have to move up-stack on purpose.

2. **It kills the proactive-configured segment.** A user who set guardians in advance self-recovers:
   rotate the key, the attacker's stolen key is now *retired* and **its signatures are refused**
   (§12.2). No race, no `WITHDRAWAL_DELAY`, no outbid. They never call us. That is the same
   population as our "registers before being hacked" segment — the one we already don't serve in the
   reactive product, so the near-term loss is small, but it is the segment that grows.

3. **The attack shifts from *drain* to *seize*, and the moat shrinks from hours to ~1 second.**
   Post-FUAA the sophisticated first move is **reconfigure-to-lock**: the attacker (holding the
   seed, satisfying a legacy account's implicit reconfiguration policy — §12.1 confirms a legacy key
   alone authorizes the first upgrade) installs a config that **retires the owner's key**. Once it
   activates, the owner can sign nothing — *our entire mechanism dies*, because it is built on the
   victim signing authorizations in their own wallet. And the defensive clock is no longer the
   8–13h unbonding delay; it is the **k=3-block (~0.9s)** reconfiguration-activation window. Our
   `WITHDRAWAL_DELAY` moat partially erodes: the attacker no longer needs to wait for the unlock to
   win outright.

That third point is the real one. It is not "FUAA obsoletes us." It is "FUAA moves the fight to a
new boundary and shortens the clock by four orders of magnitude."

---

## Why it does *not* obsolete us (the honest limits of FUAA)

1. **Our reactive core is not served.** The already-compromised user who never configured guardians
   gets no gift: the attacker holds the seed and satisfies the *default* reconfiguration policy
   exactly as the owner does. FUAA doesn't recover them — it just changes what the two sides race
   over. For this user, FUAA is neutral-to-worse, and the race is still the only lever.

2. **The k=3-block reconfiguration race is a boundary we are already built for.** Attacker fires
   reconfigure-to-lock → 3 blocks until activation. During those 3 blocks the owner's key still
   works. If the owner (via us) can push a competing reconfiguration into the single pending slot,
   the attacker never activates. That is the **anti-revoke nonce war** (Q28–Q34) with the delegation
   swapped for the pending-config slot. Same engine.

3. **A shorter clock makes our automation *more* valuable, not less.** A human cannot react inside
   ~0.9s. Only a pre-armed, local-node-resident, pre-queued system can. That is precisely what we
   have spent Phase 0/1 building. The narrower the window, the higher the premium on being the
   fastest system that exists — which is the whole thesis of this repo.

4. **"Retirement" may not be clean.** The Ethereum analogue (EIP-7702 + EIP-3607) shows that
   disabling an account's tx authority does **not** stop the old ECDSA key from authorizing via
   `ecRecover` in immutable contracts (ERC-20 `permit`), which needed a *separate* fix, **EIP-8151**,
   to patch `ecRecover`. If Monad ships FUAA without the equivalent `ecRecover` handling, a *retired*
   key is still dangerous through permit-style paths — a residual-risk surface a monitoring/response
   service can own. **UNVERIFIED for Monad; check the spec.**

5. **It's a draft.** Legacy accounts are unaffected until configured, so **our current product is
   untouched today.** The cluster battle-test (epoch 1136, in flight) is still exactly as valid as
   it was, and finishing it validates the engine we'd carry into the FUAA world.

---

## What transfers — our durable asset

Not "the staked-MON-at-unlock rescuer." That framing is the part at risk. What transfers is the
**race engine and everything measured to build it**, none of which is specific to `withdraw()`:

- run beside a local node; detection bounded by the round-trip we poll (~8ms local vs ~116ms remote);
- **parallel broadcast, first-acceptance return** (the Q34 fix), spray / pre-queue, outbid, and the
  **re-assertion war** on a contended slot at a protocol boundary (Q28–Q34);
- the **destination-locked-guardian discipline** — `SAFE_ADDRESS` immutable, no function takes a
  recipient, so an attacker calling our code still moves funds to the owner. The FUAA analogue is a
  guardian authenticator that can only ever reconfigure *toward the owner*, never seize.

The boundary changes (withdraw-unlock → reconfiguration-activation); the machine that wins boundaries
does not.

---

## Opportunities — evolve, early-mover (the point)

FUAA is new. The UX and infra layers around a brand-new primitive are unclaimed for a window. Five,
roughly in order of fit to what we already have:

1. **Reconfiguration-race rescue (reactive, new boundary).** The direct heir to today's product. Watch
   for a hostile pending-config (a foreign authenticator being installed, owner's key being retired);
   inside the k=3-block window, push the owner's counter-reconfiguration into the pending slot and keep
   re-asserting it. Our anti-revoke engine, retargeted. **Viability hinges on the pending-slot
   replacement semantics — see Open questions. If first-writer locks the slot, it's a pure
   detection-latency race (our ~8ms edge decides). If last-writer wins, it's the Q29 re-assert war.**

2. **Guardian-as-a-service (proactive — finally viable).** FUAA makes pre-registration *native and
   cheap* (one config call, not a smart-wallet migration), which is exactly what could flip our
   "nobody registers before being hacked" problem. We become a professional guardian: the user adds
   our **threshold cell** (k-of-n, so no single node of ours is a custody risk) to their
   `reconfiguration_policy`. On compromise we co-sign recovery. Recurring revenue, low custody risk,
   and it mirrors our destination-lock discipline: a guardian that can only help move *toward the
   owner*.

3. **Watcher / auto-response, retargeted.** The watcher already on our roadmap becomes the connective
   tissue for both worlds: monitor accounts for hostile pending-configs *and* hostile undelegations,
   fire the right counter automatically. Detection latency is our measured edge and it matters more as
   the clock shrinks.

4. **Post-recovery hardening (the retired-key gap).** If Monad leaves the `ecRecover`/permit surface
   open (point 4 above), offer a post-recovery sweep of outstanding `permit` allowances and monitoring
   for retired-key abuse. Niche, but it is safety nobody else is looking at yet.

5. **Migration / onboarding UX.** The first legacy→configured upgrade (§12.1) is a single
   `AuthConfigManager` tx, but doing it *correctly* — a sane, non-brickable policy, proofs of
   possession, sensible guardian defaults — is error-prone, and FUAA explicitly guards against
   accidentally installing an unsatisfiable (bricking) config. A guided "harden your account" tool
   captures the UX layer before wallets standardize it. Early-mover land-grab on a new primitive.

The through-line: stop being a *staked-MON rescuer* and become a **key-compromise response engine** —
one machine that races whatever boundary the attack of the day runs at (undelegate-unlock today,
reconfiguration-activation post-FUAA), plus the proactive guardian layer FUAA newly makes worthwhile.

---

## Open technical questions — resolve when the spec lands

These decide whether Opportunity 1 is a product or a footnote. All **UNVERIFIED** (the draft defers
the implementation spec):

- **Pending-config replacement semantics.** "At most one pending configuration" — can a second
  reconfiguration *replace* the pending one, or does the first lock the slot until it activates?
  First-writer-locks → detection-latency race (our edge). Last-writer-wins → Q29 re-assert war (our
  edge, differently). Reject-second → whoever fires first wins outright, period. **This single rule
  sets the entire shape of the reactive product.**
- **Ordering of `AuthConfigManager` calls.** Is it under the same priority-gas auction as everything
  else (so *outbidding* buys pending-slot position, as it buys flip-block position today)? If yes,
  our fee machinery transfers wholesale.
- **`ecRecover` for retired keys.** Does Monad ship the EIP-8151 equivalent, or is a retired key still
  live through permit/immutable-contract paths?
- **key→address index edge cases.** FUAA adopts the Aptos `OriginatingAddress` model (reverse
  key→address table, one entry per key, updated on rotation). Aptos's own history shows the sharp
  edges: rotating to a key already in the table is blocked to prevent lookup-hijack, and passkey
  rotations that can't produce a rotation proof *don't* update the table (a `set_originating_address`
  follow-up is needed). A shared **guardian** key legitimately controls many accounts — how the index
  handles that (FUAA notes it stores a *set*) affects guardian-service design directly.
- **7702 × configured accounts.** §12.2: an authorization tuple is honored iff its signatures satisfy
  the authority's *effective signing policy* when processed, and a tuple signed by a *retired* key is
  refused. Our anti-revoke window is 7702 tuples signed by the victim. Against a *configured* victim,
  the window's tuples are evaluated against the live signing policy — so if the attacker's
  reconfiguration retires the victim key first, our carried authorizations go dead. The reconfiguration
  race therefore *precedes* and *dominates* the delegation race. Sequence matters; model it.
- **Boundary A/B, but for reconfiguration.** Does the k-block activation interact with the epoch
  boundary the way delegation activation does (n+1 vs n+2)? Unknown; measurable once it's live.

---

## Near-term posture

- **Ship nothing new on this yet.** It's a draft; legacy accounts are unaffected; our product still
  has the field to itself for the reactive-compromise case.
- **Finish the cluster battle-test.** It validates the exact engine (parallel broadcast, re-assert
  war, local-node speed) we would carry into the reconfiguration boundary. Not wasted — foundational.
- **Track the MIP to implementation spec.** The moment the pending-slot and ordering rules are
  written down, run the reconfiguration-race experiments — the Q-series continues straight into this
  domain (Q35+: hostile-pending-config detection latency; pending-slot replacement; AuthConfigManager
  ordering under the fee auction).
- **Keep the framing honest.** FUAA is a boundary shift, not a death. We lose the proactive-configured
  user and part of the unbonding moat; we keep the reactive core, the race engine, and every measured
  fact — and we gain two adjacent products (reconfiguration-race rescue, guardian-as-a-service) that
  sit directly on the infrastructure we already built.
