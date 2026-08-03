import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARTIFACT_DIR = join(HERE, '..', 'artifacts');

/**
 * Record a finding to research/artifacts/. FINDINGS.md cites these, so every verdict is
 * traceable back to a transaction hash rather than to an assertion.
 */
export async function writeArtifact(name: string, data: unknown): Promise<string> {
  await mkdir(ARTIFACT_DIR, { recursive: true });
  const path = join(ARTIFACT_DIR, `${name}.json`);
  const body = JSON.stringify(
    data,
    (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
    2,
  );
  await writeFile(path, body + '\n');
  console.log(`artifact -> research/artifacts/${name}.json`);
  return path;
}

export function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) {
    throw new Error(
      `missing required environment variable ${key}. See research/.env.example. ` +
        `Secrets are passed at runtime and never committed.`,
    );
  }
  return v;
}

/** MonRescue contract ABI, kept in sync with contracts/src/MonRescue.sol. */
export const MONRESCUE_ABI = [
  {
    type: 'function',
    name: 'rescue',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'validatorIds', type: 'uint64[]' },
      { name: 'withdrawIds', type: 'uint8[]' },
      { name: 'claimRewardsToo', type: 'bool' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'sweep',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: [],
  },
  {
    type: 'function',
    name: 'sweepableAmount',
    stateMutability: 'view',
    inputs: [{ name: 'startingBalance', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'SAFE_ADDRESS',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'GUARDIAN',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'event',
    name: 'Rescued',
    inputs: [
      { name: 'safeAddress', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'validatorCount', type: 'uint256', indexed: false },
    ],
  },
] as const;
