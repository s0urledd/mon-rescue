# How the user authorizes us — and what an attacker can do about it

Three questions decide whether this works at all:

1. How does a user with **no MON** authorize anything?
2. If a sweeper steals whatever we send them, how does that not break the setup?
3. Can the attacker **revoke** the authorization before the withdrawal matures?

---

## 1. Signing costs nothing. Only submitting costs gas.

An EIP-7702 authorization is a **signature over `[chain_id, address, nonce]`**, produced in the
user's own wallet. It is not a transaction. It touches no chain, needs no gas, and needs no MON.

The transaction that *carries* that signature is a separate thing, and per the spec it may be
sent by anyone:

> "The authorization can be submitted by the EOA themselves, **or by anyone else** … This will
> allow EOAs to behave like smart contracts without any funds for gas!"

So the user signs; **we** submit and pay. A completely empty wallet can be protected and
rescued. There is never a moment where the user needs a balance.

## 2. We never send the victim anything, so there is nothing to steal

The rescue transaction is sent **by the guardian**, paid **by the guardian**, and merely
*targets* the victim's address. The victim's balance is irrelevant to whether it executes.

This is the structural advantage over the classic Ethereum rescue pattern. Tools built on
`searcher-sponsored-tx` must first send ETH to the compromised wallet so it can pay its own
gas, and a sweeper bot takes that ETH on arrival — which is the entire reason those tools need
Flashbots bundles to make the funding and the spend atomic. We never fund the victim, so that
race does not exist for us.

**Corollary, and it matters:** never "help" an empty victim by sending it MON. That recreates
the race, donates money to the attacker, and buys nothing.

---

## 3. Revocation — the real limit

There is **no revoke primitive** in EIP-7702. An authorization has no expiry and cannot be
cancelled. The one and only way to invalidate one is to **spend its nonce**, because validation
is a strict equality check against the account's current nonce.

That is what an attacker can do, and it is worth being precise about the cost to them.

### What it costs the attacker

Each nonce bump requires a transaction whose authority is the victim account. Two routes:

- **Send a transaction from the EOA.** This requires the EOA to hold gas — so an attacker
  facing an empty wallet must **fund it first**. That funding is visible, and it is partly
  recoverable by our sweep (the reserve floor is `min(start, 10 MON)`, so anything above what
  they deposited is ours).
- **Have a sponsor submit a type-`0x04`.** Applying any authorization increments the authority's
  nonce by one, so this works without the EOA holding gas. It costs the sponsor ~25k gas per
  authorization.

The second route is cheap. **A determined, attentive attacker can burn through an authorization
window.** That is the honest limit, and it is the same limit stated everywhere else in this
project: a seed holder who is watching and willing to spend wins.

### What we do about it

**A window, not a single authorization.** During approval the user signs authorizations for a
run of consecutive nonces. At rescue time we submit every one at or above the account's current
nonce, so a handful of nonce bumps costs the attacker gas and buys them one transaction of delay
each, rather than a lockout.

Two properties make a wide window safe to hold:

- Every authorization in the window names **the same destination-locked contract**, so it does
  not matter whether one applies or all of them do — the account ends up delegated to the same
  code either way. The spec's warning about consecutive authorizations chaining is real for a
  general-purpose wallet and inert for us.
- If the window ever leaks, the holder can delegate the user's account to a contract that can
  only pay **the user's own safe address**. A leak is a nonce-griefing problem, never a
  fund-loss one.

**Monitoring, so exhaustion is never a surprise.** `assessWindow()` reports headroom and asks
for a re-sign well before the window runs out. Re-signing requires the user to still control the
account, so the warning has to come early to be worth anything.

---

## Two deployment modes

The same machinery supports two postures. Pick per user.

### Eager delegation — delegate now, keep the window as backup

Submit the first authorization immediately, so the account is delegated during normal operation.

- **Always armed.** No dependency on a window surviving to rescue time.
- **The delegation itself brakes the attacker.** A delegated account cannot use the emptying
  exception and cannot dip below the reserve floor, so an attacker's plain transfer cannot fully
  drain it. To empty it they must first undelegate and then wait 3 quiet blocks — a delay and a
  loud signal.
- **Cost: it is visible.** `eth_getCode` returns `0xef0100 ‖ contract`, so anyone inspecting the
  account sees the protection. Mitigated by deploying a **per-user contract instance**, so the
  delegate target is an unremarkable address rather than a fingerprint shared by every protected
  wallet.

### Lazy delegation — sign now, delegate only when rescuing

Hold the signatures and submit nothing until the rescue itself. The rescue transaction carries
the authorization in its `authorizationList`, which the spec processes **before** the top-level
call — so one transaction delegates the account and executes the rescue atomically.

- **Invisible.** Until the moment of rescue the account is an ordinary EOA. There is nothing
  on-chain to reveal that it is protected, and nothing for an attacker to notice and undo.
- **The user never sends a transaction at all**, so they need no MON at any point.
- **Cost: no reserve-rule brake**, and the whole rescue depends on the window still being valid
  when it is needed.

**Recommendation: eager for a wallet already holding a large staked position** — being armed
matters more than being hidden, and the reserve brake is a genuine speed bump. **Lazy for a
wallet the user believes may already be watched**, where surprise is the more valuable asset.

---

## What the user actually does

1. Choose a **safe address** — a wallet whose key is separate and has never touched the
   compromised device. Funds can only ever go here; the contract has no other path.
2. We deploy their **own rescue contract instance** with that address burned into immutable
   storage, and verify it back off-chain before it is used.
3. The user signs **N authorizations** in their own wallet, one per consecutive nonce.
4. The user signs the **rescue payload** authorizing the destination-locked sweep.
5. That is the entire ceremony. It never asks for a seed phrase or a private key, and there is
   no code path in this repository capable of accepting one. Anyone who asks a compromised user
   for a seed is robbing them.
