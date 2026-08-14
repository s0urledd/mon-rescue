/**
 * Generate the attacker's sponsor key for the mirror-atomic battle test. TEST HARNESS ONLY.
 *
 * The mirror-design attacker needs its own funded account to send (sponsor) its drains from —
 * the equivalent of our guardian. This prints a throwaway key to paste into .env and an address
 * to fund for gas.
 *
 *   pnpm --filter @monrescue/research gen-sponsor
 */
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const pk = generatePrivateKey();
const address = privateKeyToAccount(pk).address;
console.log(`# attacker sponsor (their guardian) — fund for gas, ~5 MON covers a full window`);
console.log(`ATTACKER_SPONSOR_KEY=${pk}`);
console.log(`# address: ${address}`);
