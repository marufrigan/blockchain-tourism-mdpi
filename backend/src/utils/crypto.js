/**
 * Envelope encryption for PCTF payloads.
 * Each record gets its own random 256-bit data key (DEK). The payload is encrypted with
 * AES-256-GCM under the DEK, and the DEK is wrapped (AES-256-GCM) under the key-encryption
 * key (KEK) held by the key-release service. Destroying a wrapped DEK makes that one record
 * permanently unreadable (crypto-shredding) without touching other records.
 */
const crypto = require("crypto");

const ALGO = "aes-256-gcm";
const IV_LEN = 12; // 96-bit nonce as recommended for GCM (NIST SP 800-38D)
const TAG_LEN = 16;

function toKey(hex, name = "key") {
  const h = String(hex || "").replace(/^0x/i, "");
  if (h.length !== 64) throw new Error(`${name} must be 64 hex characters (32 bytes)`);
  return Buffer.from(h, "hex");
}

function newDataKey() {
  return crypto.randomBytes(32);
}

function seal(key, plaintext, aad) {
  const iv = crypto.randomBytes(IV_LEN);
  const c = crypto.createCipheriv(ALGO, key, iv);
  if (aad) c.setAAD(aad);
  const enc = Buffer.concat([c.update(plaintext), c.final()]);
  return Buffer.concat([iv, enc, c.getAuthTag()]);
}

function open(key, sealed, aad) {
  const iv = sealed.subarray(0, IV_LEN);
  const tag = sealed.subarray(sealed.length - TAG_LEN);
  const enc = sealed.subarray(IV_LEN, sealed.length - TAG_LEN);
  const d = crypto.createDecipheriv(ALGO, key, iv);
  if (aad) d.setAAD(aad);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]);
}

/** Encrypt a JSON-serialisable payload with a fresh DEK. Returns { ciphertext, dek }. */
function encryptPayload(payload) {
  const dek = newDataKey();
  const plain = Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload), "utf8");
  return { ciphertext: seal(dek, plain), dek, plaintextBytes: plain.length };
}

function decryptPayload(ciphertext, dek) {
  const s = open(dek, ciphertext).toString("utf8");
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

function wrapKey(kek, dek, contextLabel) {
  return seal(kek, dek, Buffer.from(contextLabel || "", "utf8"));
}

function unwrapKey(kek, wrapped, contextLabel) {
  return open(kek, wrapped, Buffer.from(contextLabel || "", "utf8"));
}

function sha256Hex(buf) {
  return "0x" + crypto.createHash("sha256").update(buf).digest("hex");
}

module.exports = { toKey, newDataKey, encryptPayload, decryptPayload, wrapKey, unwrapKey, sha256Hex, ALGO, IV_LEN, TAG_LEN };
