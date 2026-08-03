import type { PublicClient } from 'viem';
import { STAKING_PRECOMPILE } from '@monrescue/shared';

/**
 * Compromise detection on a protected account.
 *
 * The attacker holds the seed, so they will try to *block* us, not merely outrun us. The
 * moves available to them are enumerated in FINDINGS.md; this module watches for the ones
 * that are visible on-chain and turns them into a signal the hot path can act on.
 *
 * The most valuable signal by far is a change of delegation target. Only one EIP-7702
 * delegation is active at a time, so an attacker who wants an atomic withdraw-and-steal must
 * first re-delegate the account away from the rescue contract. That re-delegation is a state
 * change we can see — it announces the attack before it completes.
 */

export type ThreatKind =
  | 'delegation_removed'
  | 'delegation_hijacked'
  | 'nonce_advanced'
  | 'balance_drained';

export interface Threat {
  kind: ThreatKind;
  detail: string;
  observedAt: number;
  /** Whether the pre-signed rescue transaction is still valid after this event. */
  rescueStillArmed: boolean;
}

export interface AccountSnapshot {
  code: string;
  nonce: number;
  balance: bigint;
}

/** The delegation indicator EIP-7702 writes into a delegated account's code. */
export function delegationTarget(code: string | undefined): `0x${string}` | undefined {
  if (!code || code.length !== 48 || !code.toLowerCase().startsWith('0xef0100')) return undefined;
  return `0x${code.slice(8)}` as `0x${string}`;
}

export async function snapshot(
  client: PublicClient,
  address: `0x${string}`,
): Promise<AccountSnapshot> {
  const [code, nonce, balance] = await Promise.all([
    client.getCode({ address }),
    client.getTransactionCount({ address }),
    client.getBalance({ address }),
  ]);
  return { code: code ?? '0x', nonce, balance };
}

/**
 * Compare two snapshots and classify what the attacker did.
 *
 * `expectedDelegate` is the rescue contract this account is supposed to point at.
 */
export function classify(
  previous: AccountSnapshot,
  current: AccountSnapshot,
  expectedDelegate: `0x${string}`,
  now: number,
): Threat[] {
  const threats: Threat[] = [];
  const prevTarget = delegationTarget(previous.code);
  const currTarget = delegationTarget(current.code);
  const expected = expectedDelegate.toLowerCase();

  if (prevTarget && !currTarget) {
    threats.push({
      kind: 'delegation_removed',
      detail:
        `Delegation cleared (was ${prevTarget}). Someone holding the key sent a 0x04 to the ` +
        `zero address. The rescue contract can no longer execute on this account until the ` +
        `delegation is re-asserted.`,
      observedAt: now,
      rescueStillArmed: false,
    });
  } else if (currTarget && currTarget.toLowerCase() !== expected) {
    threats.push({
      kind: 'delegation_hijacked',
      detail:
        `Delegation now points at ${currTarget}, not the rescue contract ${expectedDelegate}. ` +
        `This is an attacker staging an atomic withdraw-and-steal — they must re-delegate ` +
        `before they can do it in one transaction.`,
      observedAt: now,
      rescueStillArmed: false,
    });
  }

  // A nonce increase means the key holder transacted. On its own that is not proof of theft —
  // it may be the legitimate owner — but it invalidates any authorization we pre-signed
  // against the old nonce, so the hot path has to know.
  if (current.nonce > previous.nonce) {
    threats.push({
      kind: 'nonce_advanced',
      detail:
        `Account nonce moved ${previous.nonce} -> ${current.nonce}. Whoever holds the key is ` +
        `transacting. Any authorization pre-signed at the old nonce is now stale.`,
      observedAt: now,
      rescueStillArmed: false,
    });
  }

  if (current.balance < previous.balance) {
    threats.push({
      kind: 'balance_drained',
      detail: `Balance fell from ${previous.balance} to ${current.balance} wei.`,
      observedAt: now,
      rescueStillArmed: true,
    });
  }

  return threats;
}

export interface GuardOptions {
  client: PublicClient;
  address: `0x${string}`;
  expectedDelegate: `0x${string}`;
  intervalMs: number;
  onThreat: (threats: Threat[]) => void | Promise<void>;
}

/**
 * Poll an account and report threats until stopped.
 *
 * Runs alongside the epoch poll rather than replacing it: the epoch poll decides *when funds
 * become movable*, this decides *whether we still have a working path to move them*.
 */
export function watchAccount(opts: GuardOptions): () => void {
  let previous: AccountSnapshot | undefined;
  let stopped = false;

  const loop = async () => {
    while (!stopped) {
      try {
        const current = await snapshot(opts.client, opts.address);
        if (previous) {
          const threats = classify(previous, current, opts.expectedDelegate, Date.now());
          if (threats.length > 0) await opts.onThreat(threats);
        }
        previous = current;
      } catch {
        // A dropped poll must never end the watch; this process may need to run for days.
      }
      await new Promise((r) => setTimeout(r, opts.intervalMs));
    }
  };
  void loop();

  return () => {
    stopped = true;
  };
}

/** Convenience: is this account currently delegated to the contract we expect? */
export async function isArmed(
  client: PublicClient,
  address: `0x${string}`,
  expectedDelegate: `0x${string}`,
): Promise<boolean> {
  const code = await client.getCode({ address });
  const target = delegationTarget(code);
  return !!target && target.toLowerCase() === expectedDelegate.toLowerCase();
}

export { STAKING_PRECOMPILE };
