import type { ValidatorInfo } from '@monrescue/shared';

/**
 * Stateful alert engine.
 *
 * Alerts fire once per state TRANSITION, never once per poll. A validator that has been
 * jailed for three days should produce one notification, not one every polling interval —
 * an alert channel that cries wolf gets muted, and a muted channel protects nobody.
 */

export type AlertKind =
  | 'validator_inactive'
  | 'validator_recovered'
  | 'commission_raised'
  | 'zero_uptime_24h'
  | 'unexpected_undelegate'
  | 'delegation_target_changed';

export type Severity = 'info' | 'warning' | 'critical';

export interface Alert {
  kind: AlertKind;
  severity: Severity;
  /** Address this alert concerns (delegator for compromise signals, else the watcher). */
  subject: string;
  validatorId?: bigint;
  message: string;
  firedAt: number;
}

/** Per-subject observed state, used to detect transitions. */
export interface WatchState {
  validatorActive: Map<string, boolean>;
  validatorCommission: Map<string, bigint>;
  zeroUptimeSince: Map<string, number>;
  zeroUptimeAlerted: Set<string>;
  lastAlertAt: Map<string, number>;
}

export function newWatchState(): WatchState {
  return {
    validatorActive: new Map(),
    validatorCommission: new Map(),
    zeroUptimeSince: new Map(),
    zeroUptimeAlerted: new Set(),
    lastAlertAt: new Map(),
  };
}

/** Minimum gap between two alerts of the same kind for the same subject. */
export const DEBOUNCE_MS = 15 * 60 * 1000;

/** A validator with no status flags set is healthy; any flag set means degraded. */
export function isValidatorOk(v: Pick<ValidatorInfo, 'flags'>): boolean {
  return v.flags === 0n;
}

export interface UptimeSample {
  validatorId: bigint;
  uptimePercent: number;
  windowHours: number;
}

export const ZERO_UPTIME_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Diff a fresh observation against stored state and return only genuine transitions.
 * `now` is injected so the engine is deterministic under test.
 */
export function evaluateValidator(
  state: WatchState,
  v: ValidatorInfo,
  uptime: UptimeSample | undefined,
  now: number,
): Alert[] {
  const out: Alert[] = [];
  const key = v.validatorId.toString();
  const ok = isValidatorOk(v);

  const wasOk = state.validatorActive.get(key);
  if (wasOk !== undefined && wasOk !== ok) {
    out.push({
      kind: ok ? 'validator_recovered' : 'validator_inactive',
      severity: ok ? 'info' : 'critical',
      subject: key,
      validatorId: v.validatorId,
      message: ok
        ? `Validator ${key} is active again.`
        : `Validator ${key} went inactive (status flags ${v.flags}). Your stake stops earning while it is out of the active set.`,
      firedAt: now,
    });
  }
  state.validatorActive.set(key, ok);

  // Only a commission INCREASE is adverse; a cut is good news and should not alarm anyone.
  const prevCommission = state.validatorCommission.get(key);
  if (prevCommission !== undefined && v.commission > prevCommission) {
    out.push({
      kind: 'commission_raised',
      severity: 'warning',
      subject: key,
      validatorId: v.validatorId,
      message:
        `Validator ${key} raised commission from ${formatCommission(prevCommission)} to ` +
        `${formatCommission(v.commission)}. You keep less of your rewards from now on.`,
      firedAt: now,
    });
  }
  state.validatorCommission.set(key, v.commission);

  if (uptime) {
    if (uptime.uptimePercent === 0) {
      const since = state.zeroUptimeSince.get(key);
      if (since === undefined) {
        state.zeroUptimeSince.set(key, now);
      } else if (now - since >= ZERO_UPTIME_WINDOW_MS && !state.zeroUptimeAlerted.has(key)) {
        state.zeroUptimeAlerted.add(key);
        out.push({
          kind: 'zero_uptime_24h',
          severity: 'critical',
          subject: key,
          validatorId: v.validatorId,
          message: `Validator ${key} has produced nothing for 24h+. It is almost certainly down — consider redelegating.`,
          firedAt: now,
        });
      }
    } else {
      state.zeroUptimeSince.delete(key);
      state.zeroUptimeAlerted.delete(key);
    }
  }

  return out.filter((a) => admit(state, a, now));
}

/**
 * Compromise signals on a watched delegator address.
 *
 * These are the bridge from alerting into the rescue flow. `delegation_target_changed` is the
 * highest-value signal we have: because only one EIP-7702 delegation can be active at a time,
 * an attacker who wants an atomic withdraw-and-steal must first re-delegate the EOA away from
 * the user's rescue contract — which announces the attack before it completes.
 */
export function evaluateDelegatorEvent(
  state: WatchState,
  subject: string,
  event:
    | { type: 'undelegate'; validatorId: bigint; amount: bigint }
    | { type: 'delegation_target_changed'; from: string; to: string },
  now: number,
): Alert[] {
  const alerts: Alert[] =
    event.type === 'undelegate'
      ? [{
          kind: 'unexpected_undelegate',
          severity: 'critical',
          subject,
          validatorId: event.validatorId,
          message:
            `Unexpected unstake detected on ${short(subject)}: ${formatMon(event.amount)} MON from ` +
            `validator ${event.validatorId}. If you did not do this, your key may be compromised.`,
          firedAt: now,
        }]
      : [{
          kind: 'delegation_target_changed',
          severity: 'critical',
          subject,
          message:
            `The account delegation for ${short(subject)} changed from ${short(event.from)} to ` +
            `${short(event.to)}. If you did not authorize this, someone with your key is ` +
            `preparing to move funds.`,
          firedAt: now,
        }];

  return alerts.filter((a) => admit(state, a, now));
}

function admit(state: WatchState, alert: Alert, now: number): boolean {
  const key = `${alert.kind}:${alert.subject}`;
  const last = state.lastAlertAt.get(key);
  if (last !== undefined && now - last < DEBOUNCE_MS) return false;
  state.lastAlertAt.set(key, now);
  return true;
}

/** Commission is expressed with 1e18 = 100%. */
export function formatCommission(c: bigint): string {
  const bps = (c * 10_000n) / 10n ** 18n;
  return `${Number(bps) / 100}%`;
}

export function formatMon(wei: bigint): string {
  return (Number(wei / 10n ** 15n) / 1000).toLocaleString(undefined, { maximumFractionDigits: 3 });
}

function short(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}
