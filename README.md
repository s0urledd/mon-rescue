# MonRescue

Key-compromise recovery for Monad delegators.

MonRescue is an experimental, non-custodial system for recovering staked and unbonding MON from a compromised account. It combines a staking-event watcher, pre-signed EIP-7702 authorizations, a guardian-funded transaction sender, and a destination-locked rescue contract.

The system must be configured before the account is compromised. It cannot recover liquid MON that an attacker can transfer immediately.

> **Status:** Active research prototype. The core claim-and-sweep flow has been verified on Monad testnet. The contracts have not been audited and the system is not ready for production use.

## Threat model

MonRescue assumes that:

- an attacker has obtained the delegator's private key;
- the owner previously selected a separate safe address;
- the rescue contract and EIP-7702 authorizations were prepared before the compromise; and
- an independent guardian can pay for and submit rescue transactions.

The attacker can transfer liquid MON, change the account's delegation, advance its nonce, and compete on transaction fees. MonRescue does not remove those capabilities. It provides a pre-authorized path that attempts to claim matured staking withdrawals and move them to the safe address before the attacker can do so.

Recovery is therefore competitive, not guaranteed. The outcome depends on authorization coverage, transaction ordering, fee policy, broadcast latency, and the attacker's behavior.

## How it works

1. A separate rescue contract is deployed for the delegator. The safe address is stored as an immutable constructor value.
2. The delegator signs EIP-7702 authorizations for that contract. Signing does not require sharing a seed phrase or private key.
3. The watcher monitors staking activity. An `Undelegate` event identifies the validator, withdrawal slot, amount, and maturity epoch.
4. At maturity, a guardian-funded transaction applies a valid authorization and calls `rescue()` on the delegated account.
5. `rescue()` calls the staking precompile and sweeps the resulting MON to the immutable safe address in the same transaction.

`rescue()` is intentionally permissionless. The safety boundary is the destination, not the caller: the contract exposes no function that accepts an arbitrary recipient. A caller can trigger the rescue, but cannot redirect the funds.

## Verified testnet results

| Test | Result | Evidence |
|---|---|---|
| Atomic withdrawal and sweep | Three matured withdrawals were claimed and 500.112413 MON was sent to the safe address in one transaction. The transaction was submitted by a guardian that did not hold the victim key. | [Transaction `0x6c285d49...`](https://testnet.monadvision.com/tx/0x6c285d49425cd829bb74dc784818fcbd0279a8fcb4fa0736c98460d2b313e17b), block 51,416,783 |
| Competing EIP-7702 re-delegations | In one controlled run against an adversary advancing the victim nonce at approximately 10 re-delegations per block, the safe balance increased by 100.385688 MON and the attacker sink balance did not change. | [`research/FINDINGS.md`, Q35](research/FINDINGS.md#q35--first-win-against-a-bursting-attacker-the-parallel-cluster-takes-the-position-verified-on-chain) |

The second result was obtained with a four-transaction authorization cluster and a 3x fee advantage. It is a single controlled test, not evidence of a guaranteed win against every sweeper.

## Current limitations

- Setup after compromise is outside the supported model.
- Liquid MON can be transferred immediately by the key holder and is not recoverable through this mechanism.
- A determined attacker can invalidate signed authorizations by advancing the account nonce.
- The current authorization cluster was tested against a burst rate of approximately 10 nonce changes per block. Faster or adaptive strategies remain open research.
- Fee parity and attacker outbidding are not yet settled.
- Results are from testnet unless a finding explicitly says otherwise.
- The contracts and operational tooling have not received an external security audit.

See [`research/FINDINGS.md`](research/FINDINGS.md) for the complete experiment log, including failed runs, corrected assumptions, transaction evidence, and unresolved questions.

## Repository layout

| Path | Purpose |
|---|---|
| [`contracts/`](contracts/) | Destination-locked rescue contract and adversary test contract |
| [`watcher/`](watcher/) | Staking-event monitoring and alerting |
| [`rescue-cli/`](rescue-cli/) | Authorization, simulation, fee planning, and broadcast logic |
| [`packages/shared/`](packages/shared/) | Chain configuration, epoch calculations, transport, and shared staking logic |
| [`research/`](research/) | Testnet experiments and recorded findings |
| [`STEPS.md`](STEPS.md) | Reproduction procedure from a fresh clone |
| [`RUNBOOK.md`](RUNBOOK.md) | Operational runbook |
| [`approval/AUTHORIZATION.md`](approval/AUTHORIZATION.md) | Authorization model and nonce-revocation analysis |

## Local setup

The workspace uses pnpm.

```bash
pnpm install
pnpm --filter @monrescue/shared build
pnpm typecheck
pnpm run build:contracts
```

For testnet configuration and the full experiment sequence, follow [`STEPS.md`](STEPS.md). Start from [`.env.example`](.env.example) and use throwaway testnet keys only.

Do not put a production seed phrase or private key into this repository. The intended user flow requires signatures, never custody of the delegator's key.

## License

[MIT](LICENSE)
