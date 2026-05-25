const path = require("path");
require("dotenv").config({
  path: path.join(__dirname, "..", "..", "..", ".env"),
});

const ROOT = path.join(__dirname, "..", "..", "..");

module.exports = {
  port: parseInt(process.env.PORT || "3001", 10),
  rpcUrl: process.env.RPC_URL || "http://127.0.0.1:7545",
  networkId: process.env.NETWORK_ID || "5777",
  encryptionKeyHex: (process.env.ENCRYPTION_KEY || "").replace(/^0x/i, ""),
  signerPrivateKey: process.env.SIGNER_PRIVATE_KEY || "",
  storageMode: (process.env.STORAGE_MODE || "local").toLowerCase(),
  ipfsApiUrl: process.env.IPFS_API_URL || "http://127.0.0.1:5001",
  abiDir: path.join(__dirname, "..", "abi"),
  dataDir: path.join(__dirname, "..", "..", "data"),
  projectRoot: ROOT,
};
