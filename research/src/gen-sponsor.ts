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
