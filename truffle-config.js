/**
 * Truffle configuration for PCTF local demo (Ganache).
 * Default RPC: http://127.0.0.1:7545 — change host/port if your Ganache differs.
 */
require("dotenv").config();

const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:7545";
const NETWORK_ID = process.env.NETWORK_ID
  ? parseInt(process.env.NETWORK_ID, 10)
  : 5777;

module.exports = {
  networks: {
    development: {
      host: "127.0.0.1",
      port: 7545,
      network_id: NETWORK_ID,
      gas: 6721975,
      gasPrice: 20000000000,
    },
    ganache: {
      url: RPC_URL,
      /** Match Ganache CLI v7+ (network id may be non-deterministic unless pinned). */
      network_id: process.env.TRUFFLE_NETWORK_ID_STRICT
        ? NETWORK_ID
        : "*",
    },
  },

  compilers: {
    solc: {
      version: "0.8.19",
      settings: {
        optimizer: {
          enabled: true,
          runs: 200,
        },
        viaIR: false,
      },
    },
  },

  mocha: {
    timeout: 100000,
  },
};
