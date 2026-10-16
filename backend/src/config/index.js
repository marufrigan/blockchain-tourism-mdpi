const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", "..", ".env") });

const ROOT = path.join(__dirname, "..", "..", "..");

function hex32(name) {
  const v = (process.env[name] || "").replace(/^0x/i, "");
  return v;
}

module.exports = {
  port: parseInt(process.env.PORT || "3001", 10),
  rpcUrl: process.env.RPC_URL || "http://127.0.0.1:7545",
  // Key-encryption key used to wrap per-record data keys (32 bytes hex).
  kekHex: hex32("KEK_HEX"),
  // Secret pepper for HMAC pseudonyms (32 bytes hex). Never published.
  pepperHex: hex32("PSEUDONYM_PEPPER_HEX"),
  // Key-service wallet: used only to submit service transactions in demos.
  serviceKey: process.env.SERVICE_PRIVATE_KEY || "",
  storageMode: (process.env.STORAGE_MODE || "local").toLowerCase(), // local | ipfs
  authWindowSec: parseInt(process.env.AUTH_WINDOW_SEC || "120", 10),
  dataDir: process.env.DATA_DIR || path.join(ROOT, "backend", "data"),
  deploymentFile: process.env.DEPLOYMENT_FILE || path.join(ROOT, "build", "deployment.json"),
  projectRoot: ROOT,
};
