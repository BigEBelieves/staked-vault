import { ethers } from 'ethers';
export const LEGACY = typeof window !== "undefined" && window.location.pathname.startsWith("/legacy");
export const CONFIG = {
      CHAIN_ID: 8453,
      CHAIN_HEX: "0x2105",
      CHAIN_NAME: "Base",
      VAULT_VERSION: LEGACY ? 2 : 3,
      DEPOSIT_ENABLED: !LEGACY,
      DEPLOY_BLOCK: LEGACY ? 51914646 : 51972519,
      RPC_URL: "https://mainnet.base.org",
      STAKED_TOKEN: "0x731d4066a8375fc590fcd9dfe8d9e58670cb8ba3",
      BNKR_TOKEN: "0x22af33fe49fd1fa80c7149773dde5890d3c76f3b",
      USDC_TOKEN: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      // Deployed on Base mainnet (Sep 28, 2026)
      VAULT_ADDRESS: LEGACY ? "0x01b568eBCFb8c6db2Cf1c5f70c9b105f4187D92F" : "0x6E6c236D5EF18cAF835fAf2bD495ED48e3F8CCc5",
      DISTRIBUTOR_ADDRESS: LEGACY ? "0xDdf0eC9aA4d36eD07257187b524a8810c5BCF376" : "0x5E22cC89dA97c5C07F19AE332be62f9Ed41B68d5"
    };
// Public read endpoints only. Replace the primary with a domain-restricted managed
// endpoint in a reviewed build; never put a secret/server credential in this file.
export const READ_RPC_URLS = [CONFIG.RPC_URL, 'https://base-rpc.publicnode.com'];
export const readProvider = new ethers.providers.FallbackProvider(
  READ_RPC_URLS.map((url, i) => ({ provider: new ethers.providers.StaticJsonRpcProvider({url, timeout:10000}, CONFIG.CHAIN_ID), priority:i+1, weight:1, stallTimeout:2000 })), 1
);
