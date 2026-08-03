import type { SignedAuthorization } from 'viem';

/**
 * Pre-signed authorization window — the anti-blocking core.
 *
 * The attacker holds the seed, so they will try to lock us out rather than merely outrun us.
 * Their two blocking moves are re-delegating the EOA to their own contract, and bumping the
 * account nonce so any authorization we hold goes stale. This module defeats both.
 *
 * Three facts from the EIP-7702 specification make it work:
 *
 *  1. "The authorization list is processed before the execution portion of the transaction
 *     begins." So a single type-0x04 transaction can re-assert our delegation AND invoke the
 *     rescue, in that order, atomically. An attacker's re-delegation is not a permanent
 *     lockout — it is something we undo inside our own rescue transaction.
 *
 *  2. The nonce check is strict equality against the authority's CURRENT nonce, and applying
 *     an authorization increments it. So one pre-signed authorization is valid only while the
 *     account sits at exactly that nonce. An attacker sending any transaction invalidates it.
 *     The answer is to pre-sign a WINDOW of nonces during onboarding.
 *
 *  3. "If any step above fails, immediately stop processing the tuple and continue to the next
 *     tuple in the list." An authorization with the wrong nonce is skipped, not fatal — it
 *     only costs gas. So we can submit the whole window and let the matching one apply.
 *
 * The specification warns that consecutive authorizations CHAIN within one transaction: each
 * success increments the nonce, which makes the next tuple match, and "the last valid
 * occurrence" wins. For a general-purpose wallet that is a hazard. **For us it is harmless,
 * and that is a property of the destination lock**: every authorization in the window names
 * the same rescue contract, so whether one applies or all of them do, the account ends up
 * delegated to the same destination-locked code. The outcome is identical.
 *
 * That also bounds the damage if this store ever leaks. These signatures let the holder
 * delegate the user's account to a contract that can only pay the user's own safe address.
 * A leak is a nonce-griefing problem, not a fund-loss problem.
 */

export interface AuthorizationWindow {
  /** Account these authorizations belong to. */
  authority: `0x${string}`;
  /** Delegate target — the user's destination-locked rescue contract. */
  contractAddress: `0x${string}`;
  chainId: number;
  /** Lowest nonce covered. */
  startNonce: number;
  /** Authorizations, ascending by nonce, one per nonce in [startNonce, startNonce + size). */
  authorizations: SignedAuthorization[];
  signedAt: number;
}

/** How many future nonces to cover by default. Each costs ~25k gas if submitted. */
export const DEFAULT_WINDOW_SIZE = 16;

/**
 * Select the authorizations worth submitting given the account's current nonce.
 *
 * Returns every authorization at or above the current nonce, ascending. Anything below is
 * already spent and would only waste gas. Including the whole remaining window rather than
 * just the exact match is deliberate: the attacker can bump the nonce between our read and
 * our broadcast, and a window survives that where a single exact match would not.
 */
export function selectAuthorizations(
  window: AuthorizationWindow,
  currentNonce: number,
  maxToInclude = 8,
): SignedAuthorization[] {
  return window.authorizations
    .filter((a) => typeof a.nonce === 'number' && a.nonce >= currentNonce)
    .sort((a, b) => (a.nonce as number) - (b.nonce as number))
    .slice(0, maxToInclude);
}

/** Highest nonce this window can still cover. */
export function windowCeiling(window: AuthorizationWindow): number {
  return window.startNonce + window.authorizations.length - 1;
}

/**
 * Whether the window still covers the account. Once the nonce passes the ceiling we have no
 * valid authorization left and the user must re-sign — which they can only do while they still
 * control the account, so the watcher must raise this long before it happens.
 */
export function isWindowExhausted(window: AuthorizationWindow, currentNonce: number): boolean {
  return currentNonce > windowCeiling(window);
}

/** Nonces remaining before the window is exhausted. */
export function windowHeadroom(window: AuthorizationWindow, currentNonce: number): number {
  return Math.max(0, windowCeiling(window) - currentNonce + 1);
}

export interface WindowHealth {
  headroom: number;
  exhausted: boolean;
  /** True when headroom is low enough that the user should re-sign now. */
  needsRefresh: boolean;
  message: string;
}

export const REFRESH_THRESHOLD = 4;

export function assessWindow(window: AuthorizationWindow, currentNonce: number): WindowHealth {
  const headroom = windowHeadroom(window, currentNonce);
  const exhausted = isWindowExhausted(window, currentNonce);
  const needsRefresh = !exhausted && headroom <= REFRESH_THRESHOLD;

  let message: string;
  if (exhausted) {
    message =
      `Authorization window exhausted: account nonce ${currentNonce} is past the ceiling ` +
      `${windowCeiling(window)}. The rescue path cannot re-assert its delegation. The user ` +
      `must sign a new window, which requires them to still control the account.`;
  } else if (needsRefresh) {
    message =
      `Authorization window low: ${headroom} nonce(s) left (ceiling ${windowCeiling(window)}). ` +
      `Ask the user to re-sign while they still can.`;
  } else {
    message = `Authorization window healthy: ${headroom} nonce(s) of headroom.`;
  }
  return { headroom, exhausted, needsRefresh, message };
}

/**
 * Validate a window before trusting it. Guards the two mistakes that fail silently on-chain:
 * a delegate target that is not the expected rescue contract, and a chainId mismatch.
 *
 * The chainId check matters because MonRescue runs on two live chains. An authorization signed
 * with chainId 0 is valid on EVERY chain, which combined with the absence of any expiry makes
 * it a permanent cross-chain capability. We refuse those.
 */
export function validateWindow(
  window: AuthorizationWindow,
  expectedChainId: number,
  expectedContract: `0x${string}`,
): void {
  if (window.chainId !== expectedChainId) {
    throw new Error(
      `authorization window is for chain ${window.chainId}, expected ${expectedChainId}`,
    );
  }
  if (window.contractAddress.toLowerCase() !== expectedContract.toLowerCase()) {
    throw new Error(
      `authorization window delegates to ${window.contractAddress}, expected the rescue ` +
        `contract ${expectedContract}`,
    );
  }
  for (const a of window.authorizations) {
    if (a.chainId === 0) {
      throw new Error(
        'refusing an authorization signed with chainId 0: it is valid on every chain and ' +
          'never expires, which makes it a permanent cross-chain capability over the account',
      );
    }
    if (a.chainId !== expectedChainId) {
      throw new Error(`authorization at nonce ${a.nonce} has chainId ${a.chainId}`);
    }
    if (a.address.toLowerCase() !== expectedContract.toLowerCase()) {
      throw new Error(`authorization at nonce ${a.nonce} delegates to ${a.address}`);
    }
  }
  if (window.authorizations.length === 0) {
    throw new Error('authorization window is empty');
  }
}
