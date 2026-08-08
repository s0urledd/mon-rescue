import type { PublicClient } from 'viem';
import { formatEther } from 'viem';
import { planSweep } from '@monrescue/shared';
import { MONRESCUE_ABI } from './abi.js';

/**
 * Exercise the failure branches before arming, not after losing.
 *
 * Three battle tests produced three different defects, and every one of them sat on a path that
 * only runs when something goes wrong: a failing `withdraw()`, an attempt before maturity, the
 * inflight cap biting, an already-emptied slot. The happy path — position matures, withdraw
 * succeeds, sweep runs — was proven once and has worked every time since.
 *
 * That is not bad luck. Those branches execute only during a race we get one shot at every
 * ~12 hours, so the interesting behaviour of the system lives in code we could not run on
 * demand. The answer is not more care; it is being able to run them on demand.
 *
 * Every check here is an `eth_call` against live state. Nothing is broadcast, nothing costs gas,
 * and the whole set takes seconds. A fatal failure aborts the arm rather than warning, because a
 * warning at 3am before a five-hour wait is a warning nobody acts on.
 */

export interface PathCheck {
  name: string;
  ok: boolean;
  fatal: boolean;
  detail: string;
}

export interface SimulateInput {
  client: PublicClient;
  guardian: `0x${string}`;
  victim: `0x${string}`;
  validatorIds: bigint[];
  withdrawIds: number[];
  claimRewards: boolean;
  /** The gas limit `arm` intends to use for each attempt. */
  gas: bigint;
  /** Safe-address gain that will be treated as "rescue complete". */
  doneThreshold: bigint;
  /** Total MON held in the withdrawal slots being rescued. */
  totalAmount: bigint;
}

/**
 * Simulate a call and name the failure precisely.
 *
 * `client.call` reports a custom-error revert as "Execution reverted for an unknown reason",
 * which is worse than useless here: `NothingToSweep` (expected, benign) and an out-of-gas death
 * (fatal) would read identically, and a check that cannot tell them apart is a check that will
 * pass while the system is broken. Walking the error chain for the decoded `errorName` is what
 * makes the distinction, so it is done rather than pattern-matched on prose.
 */
async function callOk(
  client: PublicClient,
  guardian: `0x${string}`,
  victim: `0x${string}`,
  functionName: 'rescue' | 'sweep',
  args: readonly unknown[],
  gas: bigint,
): Promise<{ ok: boolean; reason?: string; errorName?: string }> {
  try {
    await client.simulateContract({
      account: guardian, address: victim, abi: MONRESCUE_ABI,
      functionName, args: args as never, gas,
    } as never);
    return { ok: true };
  } catch (e) {
    // viem nests the decoded revert; `walk` finds it without depending on message text.
    const err = e as { walk?: (fn: (x: unknown) => boolean) => unknown; message: string };
    let errorName: string | undefined;
    const revert = err.walk?.((x) => (x as { name?: string })?.name === 'ContractFunctionRevertedError') as
      { data?: { errorName?: string }; reason?: string } | undefined;
    if (revert) errorName = revert.data?.errorName ?? revert.reason;
    const oog = /out of gas/i.test(err.message);
    return {
      ok: false,
      errorName,
      reason: oog ? 'out of gas' : errorName ?? err.message.split('\n')[0]!,
    };
  }
}

export async function simulateRescuePaths(p: SimulateInput): Promise<PathCheck[]> {
  const checks: PathCheck[] = [];
  const rescueArgs = [p.validatorIds, p.withdrawIds, p.claimRewards] as const;
  const victimBalance = await p.client.getBalance({ address: p.victim });

  // --- 1. Would a PREMATURE attempt satisfy the completion test? ------------
  //
  // The epoch 1040 loss in one line. Before maturity `withdraw()` fails, but `_sweep()` still
  // moves everything above the reserve floor — correct, and *progress*, but not the position.
  // If that amount clears the done threshold, the first attempt of the spray reports success and
  // the run exits while the position is still locked. It cost the whole 100 MON.
  const prematureSweep = planSweep(victimBalance, 0n).sweepable;
  checks.push({
    name: 'premature sweep cannot be mistaken for completion',
    ok: prematureSweep < p.doneThreshold,
    fatal: true,
    detail:
      `a pre-maturity attempt would move ${formatEther(prematureSweep)} MON (loose balance above ` +
      `the floor); completion needs ${formatEther(p.doneThreshold)} MON` +
      (prematureSweep < p.doneThreshold
        ? ' — distinguishable'
        : ' — INDISTINGUISHABLE, the spray would stop on the first attempt'),
  });

  // --- 2. Does the planned gas survive a FAILING withdraw? -----------------
  //
  // The epoch 1035 loss. The slot is not matured yet, so this call exercises exactly that path:
  // withdraw fails, consumes everything forwarded to it, and the sweep needs what is left.
  const atPlanned = await callOk(p.client, p.guardian, p.victim, 'rescue', rescueArgs, p.gas);
  const outOfGas = !atPlanned.ok && /out of gas/i.test(atPlanned.reason ?? '');
  checks.push({
    name: 'planned gas survives a failing withdraw',
    ok: !outOfGas,
    fatal: true,
    detail: atPlanned.ok
      ? `rescue() at ${p.gas} gas executes (withdraw fails, sweep runs)`
      : outOfGas
        ? `rescue() at ${p.gas} gas reverts OUT OF GAS — every attempt would be dead on arrival`
        : `rescue() reverts with ${atPlanned.reason} — not a gas failure` +
          (atPlanned.errorName === 'NothingToSweep'
            ? ' (expected: the withdraw is not matured and there is nothing loose to sweep)'
            : ''),
  });

  // --- 3. How much margin is there? ---------------------------------------
  if (!outOfGas) {
    let lo = 25_000n;
    let hi = p.gas;
    while (hi - lo > 2_000n) {
      const mid = (lo + hi) / 2n;
      const r = await callOk(p.client, p.guardian, p.victim, 'rescue', rescueArgs, mid);
      if (r.reason === 'out of gas') lo = mid; else hi = mid;
    }
    const marginPct = Number(((p.gas - hi) * 100n) / p.gas);
    // Say which path was measured. With nothing loose to sweep the call reverts before the
    // transfer, so the floor excludes the sweep's cold-account cost (~19k) and reads lower than
    // the number that will matter at maturity. A floor that quietly measures a shorter path is
    // exactly the kind of reassuring-but-wrong signal this whole gate exists to stop.
    const measuredPath = prematureSweep > 0n
      ? 'failing withdraw + sweep'
      : 'failing withdraw only — nothing loose, so the sweep never ran; the real floor is higher';
    checks.push({
      name: 'gas margin over the measured floor',
      ok: marginPct >= 20,
      fatal: false,
      detail: `floor ~${hi} (${measuredPath}), planned ${p.gas} — ${marginPct}% margin` +
        (marginPct >= 20 ? '' : ' — thin; being short costs the position, being long costs the difference'),
    });
  }

  // --- 4. Is the standalone sweep path usable? -----------------------------
  //
  // The state a lost withdrawal race leaves behind: empty slot, live balance. `rescue()` cannot
  // always reach it, `sweep()` always can, and it is the fallback we actually used to recover
  // 114.97 MON after epoch 1035.
  const sweepGas = BigInt(process.env.SWEEP_GAS_LIMIT ?? 120_000);
  const sweepSim = await callOk(p.client, p.guardian, p.victim, 'sweep', [], sweepGas);
  checks.push({
    name: 'standalone sweep() is callable',
    ok: sweepSim.ok || sweepSim.errorName === 'NothingToSweep',
    fatal: false,
    detail: sweepSim.ok
      ? `sweep() at ${sweepGas} gas would move ${formatEther(prematureSweep)} MON`
      : sweepSim.errorName === 'NothingToSweep'
        ? `nothing above the floor to sweep right now — the path is intact`
        : `sweep() reverts with ${sweepSim.reason}`,
  });

  // --- 5. Sanity on the position itself ------------------------------------
  checks.push({
    name: 'position is larger than the loose balance',
    ok: p.totalAmount > 0n,
    fatal: true,
    detail: `${formatEther(p.totalAmount)} MON in ${p.validatorIds.length} slot(s), ` +
      `victim holds ${formatEther(victimBalance)} MON loose`,
  });

  return checks;
}

export function reportChecks(checks: PathCheck[]): void {
  console.log(`\npre-arm simulation (eth_call only, nothing broadcast):`);
  for (const c of checks) {
    console.log(`  ${c.ok ? 'ok  ' : c.fatal ? 'FAIL' : 'warn'}  ${c.name}`);
    console.log(`        ${c.detail}`);
  }
  const fatal = checks.filter((c) => !c.ok && c.fatal);
  if (fatal.length > 0) {
    throw new Error(
      `pre-arm simulation failed:\n` +
        fatal.map((c) => `  - ${c.name}: ${c.detail}`).join('\n') +
        `\n\nThese paths were checked because each one has already cost a battle test. ` +
        `Set SKIP_PREARM_SIM=1 to arm anyway, deliberately.`,
    );
  }
}
