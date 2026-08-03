# The emergency path — the primary flow

**Nobody signs up before they are hacked.** People do not protect a wallet they believe is
safe, and a product that only works for users who pre-registered protects almost nobody. So the
reactive case is not the fallback here — it is the main path, and everything else is built
around it.

The user arrives **already compromised**, with no delegation, no deployed contract, and no
pre-signed anything. We have to get them from that state to armed, fast.

---

## Why this is possible at all

Because of the unbonding delay. Staked MON cannot be taken instantly — the attacker has to
`undelegate` and then wait out `WITHDRAWAL_DELAY` like everyone else. That is **2–3 epochs, on
the order of 8–13 hours** at the measured ~4.2h epoch.

That delay is the entire product. It is why a user who notices the compromise hours later still
has a real chance, and it is why the defensible asset is staked and unbonding MON rather than
liquid MON, which is gone in one block.

It also dissolves the adoption problem. Users do not need to have heard of us in advance. They
need to find us **once**, at the moment they need us.

---

## The clock, precisely

Two situations, and they have different amounts of runway.

**The attacker has already unbonded.** The unlock epoch is fixed and readable from
`getWithdrawalRequest`. We know exactly which epoch, and the boundary block is
`(epoch-1) × 50,000` with the flip landing within 5,000 blocks of it. Whatever time remains
until then is our setup window, and we can compute it to the minute.

**The stake is still bonded.** Nothing is claimable yet, so nothing can be stolen yet. Whoever
calls `undelegate` starts the clock — and either way the funds land on the EOA at `withdraw`,
where a destination-locked delegation can take them. The user unbonding immediately is usually
right: it starts the clock while we are already set up, rather than letting the attacker start
it at a moment of their choosing.

In both cases the binding constraint is **time-to-armed**, not time-to-unlock.

---

## Time-to-armed

Everything the user must do is a signature or a wallet click. Nothing requires them to hold MON.

| Step | Who pays | Wall-clock |
|---|---|---|
| Pick a safe address (fresh key, never on the compromised device) | — | minutes, user's decision |
| Deploy their rescue contract instance, destination locked | **us** | one transaction, sub-second |
| Verify `SAFE_ADDRESS()` reads back correctly | us | one call |
| User signs the authorization window in their own wallet | **nobody — signatures are free** | minutes |
| Guardian arms: pre-signs, schedules, starts watching | us | seconds |

Against 8–13 hours of unbonding, this is comfortable. The failure mode is not "too slow" — it
is the user not finding us, or hesitating over the safe address.

**The safe address is the one irreversible decision.** Funds can only ever go there, forever, and
it cannot be changed after deployment. It must be a key the compromised device has never seen.
Getting this wrong is unrecoverable, so it is the one step worth slowing down for.

---

## Where users come from

This reframes the alert bot. It is not a nice-to-have that happens to ship first — it is the
**discovery and detection channel**, and it is what makes the rescue reachable.

1. A user watches their address with the bot, for ordinary reasons: validator health, commission
   changes, rewards.
2. The bot detects an **unexpected unstake** — someone started unbonding and it was not them.
   That is the single highest-value alert we produce, because it is the moment a compromise
   becomes visible *and* the moment the clock starts.
3. The alert says what happened, how long is left, and what to do next.
4. The user runs the emergency flow.

So the bot is the funnel and the rescue is the payoff. Shipping the bot first is correct on
those grounds alone, quite apart from it being lower-risk.

It also means the bot must be genuinely useful to people who are **not** compromised, or nobody
will be watching when it matters.

---

## What changes in the design

**Contract deployment is on-demand.** One instance per user, deployed at intake rather than in
advance. Per-user instances are required anyway: a shared contract would have to store the safe
address per account, and whoever writes that mapping decides the destination — which the
attacker also controls. Immutable-at-construction is the only version of the destination lock
that survives an attacker holding the seed.

**Eager delegation is the default here.** The lazy mode's advantage is stealth, and in an
emergency the attacker is already active — there is nothing left to hide. Being armed
immediately, and getting the reserve-balance brake on the attacker's own transfers, is worth
more.

**The authorization window is less exposed.** In the preventive model a window has to survive for
months. Here it has to survive hours. The attacker can still burn nonces via sponsored
transactions, but they have to keep doing it continuously until the unlock, in public, paying
each time.

**Time-to-armed is the metric to optimise.** Not elegance, not cost. Every step the user must
take is a step some fraction of users will not complete while panicking.

---

## What we tell a user who arrives too late

Honesty here is the product.

- **Liquid MON is gone.** It is not defensible against someone holding the seed, and it will
  already have been taken.
- **Already-withdrawn stake is gone**, unless it is still sitting on the EOA — in which case a
  destination-locked sweep can still take it, and that is worth checking before assuming the
  worst.
- **Still-bonded or unbonding stake is live.** This is the case we can actually fight for.
- We will not ask for a seed phrase or a private key, and we have no code path that could accept
  one. Anyone who does ask is robbing them.
- We cannot promise a win. An attacker who is watching and willing to outbid can take it at the
  unlock block. What we offer is automation, pre-staging, and a destination that cannot be
  redirected — against an unattended or unsophisticated drainer, that is usually enough.
