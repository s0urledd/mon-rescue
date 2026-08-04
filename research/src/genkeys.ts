import { config as loadEnv } from 'dotenv';
loadEnv({ path: new URL('../../.env', import.meta.url).pathname, quiet: true });
loadEnv({ quiet: true });
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

/**
 * Generate the four test identities and print a ready-to-paste .env block.
 *
 * Throwaway testnet keys only. Nothing here should ever hold real value, and the safe address
 * in particular must be a key that has never touched a machine you consider compromised —
 * which, for a test, this satisfies trivially by being newly generated here.
 *
 *   pnpm --filter @monrescue/research genkeys
 */

const roles = [
  {
    env: 'RESEARCH_PRIVATE_KEY',
    name: 'VICTIM (and attacker — same key)',
    why:
      'The compromised wallet. It stakes, and in the battle test the adversary script signs\n' +
      '#   with this same key, because "the attacker has the seed" means exactly that.',
    funding: 'stake amount + gas for the adversary legs',
  },
  {
    env: 'GUARDIAN_PRIVATE_KEY',
    name: 'GUARDIAN',
    why:
      'Pays all gas and broadcasts the rescue. Chooses nothing: the destination is immutable\n' +
      '#   in the contract, so this key cannot redirect funds even if it is stolen.',
    funding: 'more than 10 MON — see the note below',
  },
  {
    env: 'SAFE_ADDRESS',
    name: 'SAFE ADDRESS (destination)',
    why:
      'The only place rescued funds can ever go, burned into the contract at construction.\n' +
      '#   Its private key is never used by any script here — only the address matters.',
    funding: 'none',
  },
  {
    env: 'ATTACKER_SINK',
    name: 'ATTACKER SINK',
    why: 'Where the simulated attacker tries to send. Battle test only; proves who won.',
    funding: 'none',
  },
] as const;

function main() {
  const generated = roles.map((r) => {
    const pk = generatePrivateKey();
    return { ...r, pk, address: privateKeyToAccount(pk).address };
  });

  console.log('# --- generated test identities (testnet only) ---\n');
  for (const g of generated) {
    console.log(`# ${g.name}`);
    console.log(`#   ${g.why}`);
    console.log(`#   funding: ${g.funding}`);
    console.log(`#   address: ${g.address}`);
    if (g.env.endsWith('PRIVATE_KEY')) {
      console.log(`${g.env}=${g.pk}`);
    } else {
      console.log(`${g.env}=${g.address}`);
    }
    console.log();
  }

  const victim = generated[0]!;
  const guardian = generated[1]!;
  console.log(`VICTIM_ADDRESS=${victim.address}`);
  console.log(`GUARDIAN_ADDRESS=${guardian.address}`);

  console.log(`\n# Fund at https://faucet.monad.xyz :`);
  console.log(`#   victim   ${victim.address}`);
  console.log(`#   guardian ${guardian.address}   <- must end up above 10 MON`);
  console.log(
    `#\n# The guardian threshold is not cosmetic. Monad caps an account's total gas across\n` +
      `# its inflight transactions at min(10 MON, lagged balance) over 3 blocks, so a thin\n` +
      `# guardian gets throttled at exactly the moment it needs to retry.\n` +
      `#\n# Do NOT fund the victim beyond what it needs to stake and to run the adversary.\n` +
      `# In the real flow the victim needs zero balance — the guardian pays everything.`,
  );
}

main();
