const crypto = require("crypto");
const config = require("../config");

const ALGO = "aes-256-gcm";
const IV_LEN = 16;
const AUTH_TAG_LEN = 16;

function getKey() {
  const hex = config.encryptionKeyHex;
  if (!hex || hex.length < 64) {
    throw new Error(
      "ENCRYPTION_KEY must be 64 hex characters (32 bytes). Example: openssl rand -hex 32"
    );
  }
  return Buffer.from(hex.slice(0, 64), "hex");
}

/**
 * @param {object|string} data — JSON-serialisable object or string
 * @returns {string} base64(iv + ciphertext + authTag)
 */
function encryptPayload(data) {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const plain =
    typeof data === "string" ? data : JSON.stringify(data);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const out = Buffer.concat([iv, enc, tag]);
  return out.toString("base64");
}

/**
 * @param {string} ciphertextBase64 from encryptPayload
 * @returns {object|string}
 */
function decryptPayload(ciphertextBase64) {
  const key = getKey();
  const buf = Buffer.from(ciphertextBase64, "base64");
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(buf.length - AUTH_TAG_LEN);
  const enc = buf.subarray(IV_LEN, buf.length - AUTH_TAG_LEN);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]).toString(
    "utf8"
  );
  try {
    return JSON.parse(dec);
  } catch {
    return dec;
  }
}

module.exports = { encryptPayload, decryptPayload, ALGO };
