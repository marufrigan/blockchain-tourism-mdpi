const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const config = require("../config");
const { encryptPayload } = require("../utils/crypto");

let ipfsClient = null;

async function getIpfs() {
  if (!ipfsClient) {
    const { create } = await import("ipfs-http-client");
    ipfsClient = create({ url: config.ipfsApiUrl });
  }
  return ipfsClient;
}

function ensureLocalDir() {
  const dir = path.join(config.dataDir, "encrypted");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Stores sensitive payload encrypted; returns reference string for on-chain offChainReference.
 */
async function storeEncryptedPayload(sensitivePayload) {
  const ciphertext = encryptPayload(sensitivePayload);

  if (config.storageMode === "ipfs") {
    try {
      const client = await getIpfs();
      const { cid } = await client.add(
        Buffer.from(ciphertext, "utf8"),
        { pin: true }
      );
      return `ipfs:${cid.toString()}`;
    } catch (e) {
      console.warn(
        "[storage] IPFS failed, falling back to local:",
        e.message
      );
    }
  }

  const id = crypto.randomUUID();
  const dir = ensureLocalDir();
  const filePath = path.join(dir, `${id}.enc`);
  fs.writeFileSync(filePath, ciphertext, "utf8");
  return `local:${id}`;
}

/**
 * Load ciphertext by reference (for authorised backend flows only).
 */
async function loadCiphertextByReference(ref) {
  if (!ref || typeof ref !== "string") {
    throw new Error("invalid reference");
  }
  if (ref.startsWith("ipfs:")) {
    const cid = ref.slice(5);
    const client = await getIpfs();
    const chunks = [];
    for await (const chunk of client.cat(cid)) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
  }
  if (ref.startsWith("local:")) {
    const id = ref.slice(6);
    const filePath = path.join(config.dataDir, "encrypted", `${id}.enc`);
    if (!fs.existsSync(filePath)) {
      throw new Error("local encrypted blob not found");
    }
    return fs.readFileSync(filePath, "utf8");
  }
  throw new Error("unknown reference scheme");
}

module.exports = {
  storeEncryptedPayload,
  loadCiphertextByReference,
};
