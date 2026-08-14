/**
 * Generate the attacker's sponsor key for the mirror-atomic battle test and write it straight
 * into .env. TEST HARNESS ONLY.
 *
 * The mirror-design attacker needs its own funded account to send (sponsor) its drains from —
 * the equivalent of our guardian. This generates a throwaway key, appends ATTACKER_SPONSOR_KEY
 * to the repo-root .env (replacing any existing line), and prints the address to fund for gas.
 *
 *   pnpm --filter @monrescue/research gen-sponsor
 */
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

// Repo-root .env: this file is research/src/gen-sponsor.ts, so ../../.env is the root.
const envPath = new URL('../../.env', import.meta.url).pathname;

const pk = generatePrivateKey();
const address = privateKeyToAccount(pk).address;

let env = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';

// Refuse to clobber an existing key unless forced. Overwriting orphans whatever was already
// funded to the old address — a real footgun the first time it happened. FORCE=1 to replace.
if (/^ATTACKER_SPONSOR_KEY=0x[0-9a-fA-F]+/m.test(env) && process.env.FORCE !== '1') {
  const existing = env.match(/^ATTACKER_SPONSOR_KEY=(0x[0-9a-fA-F]+)/m)![1]!;
  const existingAddr = privateKeyToAccount(existing as `0x${string}`).address;
  console.log(`ATTACKER_SPONSOR_KEY already set — keeping it, NOT generating a new one.`);
  console.log(`  existing sponsor address: ${existingAddr}`);
  console.log(`  -> make sure THIS address has ~5 MON of gas.`);
  console.log(`\n  (run with FORCE=1 to replace it, but that orphans anything funded to it.)`);
  process.exit(0);
}

const line = `ATTACKER_SPONSOR_KEY=${pk}`;
if (/^ATTACKER_SPONSOR_KEY=.*$/m.test(env)) {
  env = env.replace(/^ATTACKER_SPONSOR_KEY=.*$/m, line);
} else {
  env = env.replace(/\s*$/, '') + `\n${line}\n`;
}
writeFileSync(envPath, env);

console.log(`wrote ATTACKER_SPONSOR_KEY to ${envPath}`);
console.log(`\n  sponsor address: ${address}`);
console.log(`  -> FUND THIS with ~5 MON (the attacker's gas for a full window)`);
console.log(`\nNothing else to edit. Once funded, run the mirror-atomic battle test.`);
