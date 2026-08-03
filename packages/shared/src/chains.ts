import { defineChain } from 'viem';

/**
 * Monad chain definitions and RPC pools.
 *
 * The `rescue` pool matters: with no private mempool on Monad, the hot path
 * broadcasts the same pre-signed transaction to every endpoint at once and takes
 * whichever inclusion lands first. Order here is the broadcast order, so put the
 * lowest-latency endpoint first.
 */

export const monadMainnet = defineChain({
  id: 143,
  name: 'Monad',
  nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://rpc.monad.xyz'], webSocket: ['wss://rpc.monad.xyz'] },
  },
  blockExplorers: {
    default: { name: 'MonadVision', url: 'https://monadvision.com' },
  },
});

export const monadTestnet = defineChain({
  id: 10143,
  name: 'Monad Testnet',
  nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
  rpcUrls: {
    default: {
      http: ['https://testnet-rpc.monad.xyz'],
      webSocket: ['wss://testnet-rpc.monad.xyz'],
    },
  },
  blockExplorers: {
    default: { name: 'MonadVision Testnet', url: 'https://testnet.monadvision.com' },
  },
  testnet: true,
});

/**
 * Broadcast pools. Public endpoints are rate-limited (see docs.monad.xyz
 * network-information); the operator's own node should lead the list because the
 * rescue path is latency-bound, not throughput-bound.
 */
export const RPC_POOL: Record<number, readonly string[]> = {
  143: [
    'https://monad-rpc.huginn.tech',
    'https://rpc.monad.xyz',
    'https://rpc1.monad.xyz',
    'https://rpc2.monad.xyz',
    'https://rpc3.monad.xyz',
    'https://rpc-mainnet.monadinfra.com',
  ],
  10143: [
    'https://monad-testnet-rpc.huginn.tech',
    'https://testnet-rpc.monad.xyz',
    'https://rpc-testnet.monadinfra.com',
  ],
};

export const WS_POOL: Record<number, readonly string[]> = {
  143: ['wss://wss.monad-rpc.huginn.tech', 'wss://rpc.monad.xyz'],
  10143: ['wss://wss.monad-testnet-rpc.huginn.tech', 'wss://testnet-rpc.monad.xyz'],
};

export function chainById(id: number) {
  if (id === 143) return monadMainnet;
  if (id === 10143) return monadTestnet;
  throw new Error(`unsupported chain id ${id} (expected 143 or 10143)`);
}
