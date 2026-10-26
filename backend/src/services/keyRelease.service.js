/**
 * Key-release service (Algorithm 4).
 * A requester proves control of its wallet by signing a fresh challenge (EIP-191).
 * The service then evaluates the on-chain policy for that authenticated address, checks
 * record status, expiry and the subject's consent, and only then unwraps the data key and
 * decrypts the payload. Every decision, granted or denied, is written to the audit log.
 * No private key ever leaves the requester.
 *
 * Replay: the nonce check and nonce insertion run synchronously before the first await, so
 * concurrent copies of one challenge cannot both pass inside a single process. Accepted nonces
 * are also appended (synchronously, before any release work) to a nonce log when `nonceLog` is
 * set; on start the service reloads the nonces that are still inside the freshness window, so a
 * restart does not reopen the window for challenges already used. Several service replicas
 * would need a shared nonce store, which this prototype does not provide.
 *
 * Chain state: all on-chain checks of one decision are evaluated at a single block (the head
 * block when the request is processed), and that block number is written to the audit entry.
 * Under QBFT this block is final; on a chain with forks a confirmation depth can be set.
 */
const fs = require("fs");
const { ethers } = require("ethers");
const { decryptPayload } = require("../utils/crypto");
const { subjectPseudonymsInWindow } = require("../utils/pseudonym");

const ROLE = { ADMIN: 0, TOURIST: 1, HOTEL: 2, HEALTH: 3, TOURISM: 4 };

function challengeMessage(action, target, ts, nonce) {
  return `PCTF|${action}|${target}|${ts}|${nonce}`;
}

class KeyReleaseService {
  constructor({ registry, crm, keystore, storage, audit, pepper, authWindowSec = 120, nowFn, confirmations = 0, nonceLog = null }) {
    this.registry = registry;
    this.crm = crm; // read-only contract bound to a provider
    this.keystore = keystore;
    this.storage = storage;
    this.audit = audit;
    this.pepper = pepper;
    this.authWindowSec = authWindowSec;
    this.seenNonces = new Map();
    this.identity = new Map(); // tourist wallet (lowercase) -> subjectId, set at enrolment
    this.nowFn = nowFn || (() => Math.floor(Date.now() / 1000));
    this.confirmations = confirmations;
    this.nonceLog = nonceLog;
    if (nonceLog && fs.existsSync(nonceLog)) {
      const now = this.nowFn();
      for (const line of fs.readFileSync(nonceLog, "utf8").split("\n")) {
        const [ts, nonce] = line.split(" ");
        // a nonce accepted at time a can be replayed until a + 2W at the latest (|now - ts| <= W twice)
        if (nonce && now - Number(ts) <= 2 * this.authWindowSec) this.seenNonces.set(nonce, Number(ts));
      }
    }
  }

  /** Block at which every check of one decision is evaluated ("latest" when no provider is attached). */
  async _decisionBlock() {
    const p = this.crm.provider;
    if (!p || typeof p.getBlockNumber !== "function") return "latest";
    const n = await p.getBlockNumber();
    return Math.max(0, n - this.confirmations);
  }

  enrolTourist(address, subjectId) {
    this.identity.set(address.toLowerCase(), subjectId);
  }

  /** Verify a signed challenge. Returns the recovered address or throws. */
  authenticate({ action, target, ts, nonce, signature, claimedAddress }) {
    const now = this.nowFn();
    if (Math.abs(now - Number(ts)) > this.authWindowSec) throw new Error("stale challenge");
    if (!/^[0-9a-fA-F]{16,64}$/.test(String(nonce))) throw new Error("malformed nonce");
    if (this.seenNonces.has(nonce)) throw new Error("replayed challenge");
    const recovered = ethers.utils.verifyMessage(challengeMessage(action, target, ts, nonce), signature);
    if (claimedAddress && recovered.toLowerCase() !== claimedAddress.toLowerCase()) throw new Error("signature does not match claimed address");
    this.seenNonces.set(nonce, now);
    if (this.nonceLog) fs.appendFileSync(this.nonceLog, `${now} ${nonce}\n`);
    if (this.seenNonces.size % 4096 === 0) this._pruneNonces(now);
    return recovered;
  }

  _pruneNonces(now) {
    for (const [n, t] of this.seenNonces) if (now - t > 2 * this.authWindowSec) this.seenNonces.delete(n);
  }

  _deny(who, recordId, reason, block) {
    this.audit.append({ decision: "DENY", who, recordId: String(recordId), reason, ...(block !== undefined ? { block } : {}) });
    const e = new Error(`denied: ${reason}`);
    e.status = 403;
    throw e;
  }

  /** Release and decrypt one record for an authenticated requester. */
  async release(auth) {
    const recordId = auth.target;
    let who;
    try {
      who = this.authenticate({ ...auth, action: "release" });
    } catch (err) {
      return this._deny(auth.claimedAddress || "unknown", recordId, err.message);
    }
    let blockTag;
    let active;
    let role;
    try {
      blockTag = await this._decisionBlock();
      [active, role] = await this.registry.roleOf(who, { blockTag });
    } catch (err) {
      return this._deny(who, recordId, "chain unavailable", blockTag); // fail closed
    }
    if (!active) return this._deny(who, recordId, "not an active participant", blockTag);

    let rec;
    if (Number(role) === ROLE.TOURIST) {
      // READ_self: tourists can read only objects linked to their own wallet.
      try {
        rec = await this._readAsService(recordId, blockTag);
      } catch (err) {
        return this._deny(who, recordId, "invalid record", blockTag);
      }
      const owner = this.keystore.ownerOf(rec.contentDigest);
      if (!owner || owner !== who.toLowerCase()) return this._deny(who, recordId, "tourist may read only own records", blockTag);
    } else {
      try {
        // On-chain policy evaluated for the authenticated address (eth_call from = requester).
        rec = await this.crm.getRecord(recordId, { from: who, blockTag });
      } catch (err) {
        return this._deny(who, recordId, "on-chain policy denied", blockTag);
      }
      const owner = this.keystore.ownerOf(rec.contentDigest);
      let consent = true;
      try {
        if (owner) consent = await this.crm.consentGiven(owner, { blockTag });
      } catch (err) {
        return this._deny(who, recordId, "chain unavailable", blockTag);
      }
      if (!consent) return this._deny(who, recordId, "subject consent withdrawn", blockTag);
    }
    if (Number(rec.status) !== 0) return this._deny(who, recordId, "record not active", blockTag);
    if (Number(rec.expiresAt) !== 0 && Number(rec.expiresAt) <= this.nowFn()) return this._deny(who, recordId, "record expired", blockTag);
    const k = this.keystore.get(rec.contentDigest);
    if (!k) return this._deny(who, recordId, "data key destroyed", blockTag);
    let payload;
    try {
      const ct = await this.storage.get(rec.contentDigest, rec.storageScheme);
      payload = decryptPayload(ct, k.dek);
    } catch (err) {
      return this._deny(who, recordId, /integrity/.test(err.message) ? "integrity check failed" : "object unavailable", blockTag);
    }
    this.audit.append({ decision: "GRANT", who, role: Number(role), recordId: String(recordId), block: blockTag });
    return { recordId: String(recordId), role: Number(role), payload, block: blockTag };
  }

  /** Pseudonyms of the authenticated tourist for the last `days` epochs (own exposure check). */
  async ownPseudonyms(auth, fromTs, toTs) {
    const who = this.authenticate({ ...auth, action: "pseudonyms" });
    const [active, role] = await this.registry.roleOf(who);
    if (!active || Number(role) !== ROLE.TOURIST) this._deny(who, "-", "only tourists can request own pseudonyms");
    const sid = this.identity.get(who.toLowerCase());
    if (!sid) this._deny(who, "-", "tourist not enrolled");
    return subjectPseudonymsInWindow(this.pepper, sid, fromTs, toTs).map((x) => x.pseudonym);
  }

  /** Pseudonyms of a diagnosed subject, released only to an authenticated Health Authority. */
  async pseudonymsForDiagnosis(auth, subjectId, fromTs, toTs) {
    const who = this.authenticate({ ...auth, action: "diagnosis-pseudonyms" });
    const [active, role] = await this.registry.roleOf(who);
    if (!active || Number(role) !== ROLE.HEALTH) this._deny(who, "-", "only health authorities can link diagnosis pseudonyms");
    this.audit.append({ decision: "GRANT", who, action: "diagnosis-pseudonyms" });
    return subjectPseudonymsInWindow(this.pepper, subjectId, fromTs, toTs).map((x) => x.pseudonym);
  }

  /** Consent withdrawal handler: crypto-shred everything linked to the tourist. */
  onConsentWithdrawn(tourist) {
    const n = this.keystore.destroyAllOf(tourist);
    this.audit.append({ decision: "SHRED", who: tourist, objects: n, reason: "consent withdrawn" });
    return n;
  }

  async _readAsService(recordId, blockTag = "latest") {
    // Public minimal metadata (no pseudonyms); used to resolve ownership for READ_self.
    return this.crm.recordMeta(recordId, { blockTag });
  }
}

module.exports = { KeyReleaseService, challengeMessage, ROLE };
