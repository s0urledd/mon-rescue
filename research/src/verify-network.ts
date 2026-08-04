/**
 * Script 0 — network + ABI verification. Runs with NO funded key.
 *
 * Everything this script checks was executed during Phase 0 and is recorded in
 * FINDINGS.md. It exists so the claims stay falsifiable: if Monad changes the staking
 * precompile or its ABI, this fails loudly instead of the findings silently rotting.
 */
// Load .env with no dependency: node's built-in loader, repo root first then package-local.
// Both are optional, and a real environment variable always wins over either.
for (const p of ['../../.env', '../.env', '.env']) {
  try { process.loadEnvFile(new URL(p, import.meta.url).pathname); } catch { /* absent */ }
}
import { publicClientFor, getEpoch, getValidator, withdrawableAtEpoch, STAKING_PRECOMPILE, RESERVE_PRECOMPILE, RPC_POOL } from '@monrescue/shared';
import { createPublicClient, http, toFunctionSelector, toEventSelector } from 'viem';
import { chainById } from '@monrescue/shared';

const CHAIN_ID = Number(process.env.CHAIN_ID ?? 10143);

/** Selectors as published in the staking reference; recomputed locally to catch drift. */
const EXPECTED_SELECTORS: Record<string, string> = {
  'delegate(uint64)': '0x84994fec',
  'undelegate(uint64,uint256,uint8)': '0x5cf41514',
  'withdraw(uint64,uint8)': '0xaed2ee73',
  'claimRewards(uint64)': '0xa76e2ca5',
  'getEpoch()': '0x757991a8',
  'getValidator(uint64)': '0x2b6d639a',
  'getDelegator(uint64,address)': '0x573c1ce0',
  'getWithdrawalRequest(uint64,address,uint8)': '0x56fa2045',
  'getDelegations(address,uint64)': '0x4fd66050',
  'syscallReward(address)': '0x791bdcf3',
};

async function main() {
  let failures = 0;
  const fail = (msg: string) => { console.error(`  FAIL  ${msg}`); failures++; };
  const pass = (msg: string) => console.log(`  ok    ${msg}`);

  console.log(`\n== selectors ==`);
  for (const [sig, expected] of Object.entries(EXPECTED_SELECTORS)) {
    const actual = toFunctionSelector(`function ${sig}`);
    if (actual === expected) pass(`${sig} = ${actual}`);
    else fail(`${sig} expected ${expected}, got ${actual}`);
  }

  console.log(`\n== event topic ==`);
  const rewarded = toEventSelector('event ValidatorRewarded(uint64,address,uint256,uint64)');
  const OBSERVED = '0x3a420a01486b6b28d6ae89c51f5c3bde3e0e74eecbb646a0c481ccba3aae3754';
  if (rewarded === OBSERVED) pass(`ValidatorRewarded = ${rewarded} (matches on-chain logs)`);
  else fail(`ValidatorRewarded expected ${OBSERVED}, got ${rewarded}`);

  console.log(`\n== endpoints (chain ${CHAIN_ID}) ==`);
  const urls = RPC_POOL[CHAIN_ID] ?? [];
  const reachable: string[] = [];
  for (const url of urls) {
    try {
      const c = createPublicClient({ chain: chainById(CHAIN_ID), transport: http(url) });
      const t0 = Date.now();
      const id = await c.getChainId();
      const ms = Date.now() - t0;
      if (id !== CHAIN_ID) { fail(`${url} reports chain ${id}, expected ${CHAIN_ID}`); continue; }
      const block = await c.getBlockNumber();
      pass(`${url} chain=${id} block=${block} ${ms}ms`);
      reachable.push(url);
    } catch (e) {
      console.warn(`  warn  ${url} unreachable: ${(e as Error).message.split('\n')[0]}`);
    }
  }
  if (reachable.length === 0) { fail('no reachable RPC endpoint'); }

  if (reachable.length > 0) {
    const client = publicClientFor(CHAIN_ID, reachable[0]);

    console.log(`\n== staking precompile ==`);
    const code = await client.getCode({ address: STAKING_PRECOMPILE });
    if (!code || code === '0x') pass(`${STAKING_PRECOMPILE} has no bytecode (precompile, as expected)`);
    else fail(`${STAKING_PRECOMPILE} unexpectedly has ${(code.length - 2) / 2} bytes of code`);

    const balance = await client.getBalance({ address: STAKING_PRECOMPILE });
    if (balance > 0n) pass(`staking pool balance = ${balance / 10n ** 18n} MON`);
    else fail('staking precompile holds zero balance — wrong address?');

    const epoch = await getEpoch(client);
    pass(`getEpoch() -> epoch=${epoch.epoch} inEpochDelayPeriod=${epoch.inEpochDelayPeriod}`);
    pass(`stake undelegated now would unlock at epoch ${withdrawableAtEpoch(epoch)}`);

    const v = await getValidator(client, 1n);
    pass(`getValidator(1) -> auth=${v.authAddress} stake=${v.stake / 10n ** 18n} MON commission=${v.commission}`);

    console.log(`\n== reserve precompile ==`);
    const rCode = await client.getCode({ address: RESERVE_PRECOMPILE });
    if (!rCode || rCode === '0x') pass(`${RESERVE_PRECOMPILE} has no bytecode (precompile, as expected)`);
    else fail(`${RESERVE_PRECOMPILE} unexpectedly has code`);
  }

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
