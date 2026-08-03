/**
 * Script A — Q2: does viem actually submit a working type-0x04 transaction to Monad?
 *
 * Scanning 40 consecutive testnet blocks during Phase 0 found zero type-0x04 transactions,
 * so 7702 usage cannot be confirmed by observation — we have to submit one. This also
 * validates viem as the submission library before the hot path is built on it.
 *
 * Requires a funded testnet key.
 */
import { createWalletClient, http, formatEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { chainById, RPC_POOL, publicClientFor } from '@monrescue/shared';
import { writeArtifact, requireEnv } from './lib.js';

const CHAIN_ID = Number(process.env.CHAIN_ID ?? 10143);

async function main() {
  const pk = requireEnv('RESEARCH_PRIVATE_KEY') as `0x${string}`;
  const delegateTo = requireEnv('RESCUE_CONTRACT') as `0x${string}`;

  // Delegating an EOA *to* the staking precompile bricks it: "all calls to it will revert".
  // Guard before signing anything, because the delegation persists indefinitely.
  const FORBIDDEN = ['0x0000000000000000000000000000000000001000', '0x0000000000000000000000000000000000001001'];
  if (FORBIDDEN.includes(delegateTo.toLowerCase())) {
    throw new Error(`refusing to delegate to precompile ${delegateTo} — this would permanently brick the account`);
  }

  const account = privateKeyToAccount(pk);
  const chain = chainById(CHAIN_ID);
  const url = RPC_POOL[CHAIN_ID]![0]!;
  const publicClient = publicClientFor(CHAIN_ID, url);
  const wallet = createWalletClient({ account, chain, transport: http(url) });

  const balance = await publicClient.getBalance({ address: account.address });
  console.log(`EOA ${account.address} balance ${formatEther(balance)} MON`);
  if (balance === 0n) throw new Error('EOA has no balance — fund it from https://faucet.monad.xyz');

  const codeBefore = await publicClient.getCode({ address: account.address });
  console.log(`code before: ${codeBefore ?? '0x'} (expect 0x for a plain EOA)`);

  console.log(`\nsigning authorization delegating to ${delegateTo}...`);
  const authorization = await wallet.signAuthorization({
    account,
    contractAddress: delegateTo,
    executor: 'self',
  });

  const hash = await wallet.sendTransaction({
    authorizationList: [authorization],
    to: account.address,
    value: 0n,
  });
  console.log(`tx: ${hash}`);

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const codeAfter = await publicClient.getCode({ address: account.address });

  // A delegated account's code is exactly 0xef0100 || the 20-byte delegate address.
  const expected = `0xef0100${delegateTo.slice(2).toLowerCase()}`;
  const delegated = codeAfter?.toLowerCase() === expected;

  console.log(`code after: ${codeAfter}`);
  console.log(`expected:   ${expected}`);
  console.log(`\n>>> Q2 VERDICT: ${delegated ? 'YES — viem submits a working 0x04 and the delegation is live' : 'NO — delegation marker mismatch'}`);
  console.log(
    delegated
      ? '\nNote: this delegation is now PUBLICLY READABLE via eth_getCode. That is the stealth\n' +
        'leak documented in FINDINGS.md — deploy per-user contract instances in production.'
      : '',
  );

  await writeArtifact('q2-7702-submission', {
    question: 'Q2 — viem submits a working type-0x04 EIP-7702 transaction to Monad',
    chainId: CHAIN_ID,
    txHash: hash,
    status: receipt.status,
    txType: receipt.type,
    gasUsed: receipt.gasUsed.toString(),
    eoa: account.address,
    delegateTo,
    codeBefore: codeBefore ?? '0x',
    codeAfter: codeAfter ?? '0x',
    expectedCode: expected,
    delegationLive: delegated,
  });
}

main().catch((e) => { console.error(`\nScript A failed: ${e.message}`); process.exit(1); });
