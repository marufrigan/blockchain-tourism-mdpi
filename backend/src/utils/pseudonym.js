/**
 * Keyed pseudonyms. A plain hash of a low-entropy identifier (e.g. keccak256("tourist_123"))
 * can be reversed by trying every candidate. PCTF instead uses HMAC-SHA256 with a secret
 * pepper held by the key-release service, and rotates subject pseudonyms every epoch (day),
 * so outside observers cannot reverse them or link a subject's records across days.
 * The key-release service, which holds the pepper, can recompute the pseudonyms of one
 * subject for a given window (needed for exposure matching and own-record access).
 */
const crypto = require("crypto");

const EPOCH_SECONDS = 86400;

function hmac32(pepper, msg) {
  return "0x" + crypto.createHmac("sha256", pepper).update(msg, "utf8").digest("hex");
}

function epochOf(unixSeconds) {
  return Math.floor(Number(unixSeconds) / EPOCH_SECONDS);
}

function subjectPseudonym(pepper, subjectId, epoch) {
  return hmac32(pepper, `pctf:subject:${subjectId}:${epoch}`);
}

function venuePseudonym(pepper, venueId) {
  return hmac32(pepper, `pctf:venue:${venueId}`);
}

/** All pseudonyms of one subject for the epochs that overlap [fromTs, toTs]. */
function subjectPseudonymsInWindow(pepper, subjectId, fromTs, toTs) {
  const out = [];
  for (let e = epochOf(fromTs); e <= epochOf(toTs); e++) out.push({ epoch: e, pseudonym: subjectPseudonym(pepper, subjectId, e) });
  return out;
}

module.exports = { EPOCH_SECONDS, epochOf, subjectPseudonym, venuePseudonym, subjectPseudonymsInWindow };
