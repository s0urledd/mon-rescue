#!/usr/bin/env node
/**
 * Compile MonRescue.sol with solc directly.
 *
 * Foundry is the intended toolchain (see foundry.toml), but it cannot always be installed —
 * in the environment this was developed in, GitHub's release API was blocked by egress
 * policy. This script produces the same artifact with no Foundry dependency, so the contract
 * is always buildable and deployable.
 *
 *   npm i solc && node contracts/build.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));

let solc;
try {
  solc = require('solc');
} catch {
  console.error(
    `solc is not installed.\n\n` +
      `  pnpm install        # from the repo root — solc is a root devDependency\n\n` +
      `If that has already been run, check you are on a recent commit: solc moved from a\n` +
      `contracts-local npm install to the workspace root, because contracts/ has no\n` +
      `package.json and npm cannot resolve the workspace:* protocol there.`,
  );
  process.exit(1);
}
// Both the product contract and the adversary simulator. The second is a test harness — see
// its header — and is compiled here only so the battle test has a real opponent to run against.
const CONTRACTS = [
  { file: 'MonRescue.sol', name: 'MonRescue' },
  { file: 'AdversaryDrainer.sol', name: 'AdversaryDrainer' },
];

const input = {
  language: 'Solidity',
  sources: Object.fromEntries(
    CONTRACTS.map((c) => [c.file, { content: readFileSync(join(HERE, 'src', c.file), 'utf8') }]),
  ),
  settings: {
    optimizer: { enabled: true, runs: 200 },
    // Monad is Cancun-equivalent for general execution; EIP-7702 affects transaction
    // submission rather than the opcodes this contract uses.
    evmVersion: 'cancun',
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } },
  },
};

const output = JSON.parse(solc.compile(JSON.stringify(input)));

let failed = false;
for (const err of output.errors ?? []) {
  console.log(`[${err.severity}] ${err.formattedMessage.trim()}`);
  if (err.severity === 'error') failed = true;
}
if (failed) process.exit(1);

mkdirSync(join(HERE, 'out'), { recursive: true });
console.log(`compiled with solc ${solc.version()}`);
for (const { file, name } of CONTRACTS) {
  const contract = output.contracts[file][name];
  writeFileSync(
    join(HERE, 'out', `${name}.json`),
    JSON.stringify(
      {
        contractName: name,
        solcVersion: solc.version(),
        abi: contract.abi,
        bytecode: `0x${contract.evm.bytecode.object}`,
        deployedBytecode: `0x${contract.evm.deployedBytecode.object}`,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    `  ${name}: ${contract.evm.deployedBytecode.object.length / 2} bytes -> contracts/out/${name}.json`,
  );
}
