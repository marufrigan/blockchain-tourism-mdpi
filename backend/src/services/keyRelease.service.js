/**
 * Key-release service (Algorithm 4).
 * A requester proves control of its wallet by signing a fresh challenge (EIP-191).
 * The service then evaluates the on-chain policy for that authenticated address, checks
 * record status, expiry and the subject's consent, and only then unwraps the data key and
 * decrypts the payload. Every decision, granted or denied, is written to the audit log.
 * No private key ever leaves the requester.
 */
const { ethers } = require("ethers");
const { decryptPayload } = require("../utils/crypto");
const { subjectPseudonymsInWindow } = require("../utils/pseudonym");

const ROLE = { ADMIN: 0, TOURIST: 1, HOTEL: 2, HEALTH: 3, TOURISM: 4 };

function challengeMessage(action, target, ts, nonce) {
  return `PCTF|${action}|${target}|${ts}|${nonce}`;
}

class KeyReleaseService {
  constructor({ registry, crm, keystore, storage, audit, pepper, authWindowSec = 120, nowFn }) {
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
  }

  enrolTourist(address, subjectId) {
    this.identity.set(address.toLowerCase(), subjectId);
  }

  /** Verify a signed challenge. Returns the recovered address or throws. */
  authenticate({ action, target, ts, nonce, signature, claimedAddress }) {
    const now = this.nowFn();
    if (Math.abs(now - Number(ts)) > this.authWindowSec) throw new Error("stale challenge");
    if (this.seenNonces.has(nonce)) throw new Error("replayed challenge");
    const recovered = ethers.utils.verifyMessage(challengeMessage(action, target, ts, nonce), signature);
    if (claimedAddress && recovered.toLowerCase() !== claimedAddress.toLowerCase()) throw new Error("signature does not match claimed address");
    this.seenNonces.set(nonce, now);
    return recovered;
  }

  _deny(who, recordId, reason) {
    this.audit.append({ decision: "DENY", who, recordId: String(recordId), reason });
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
    const [active, role] = await this.registry.roleOf(who);
    if (!active) return this._deny(who, recordId, "not an active participant");

    let rec;
    if (Number(role) === ROLE.TOURIST) {
      // READ_self: tourists can read only objects linked to their own wallet.
      rec = await this._readAsService(recordId);
      const owner = this.keystore.ownerOf(rec.contentDigest);
      if (!owner || owner !== who.toLowerCase()) return this._deny(who, recordId, "tourist may read only own records");
    } else {
      try {
        // On-chain policy evaluated for the authenticated address (eth_call from = requester).
        rec = await this.crm.getRecord(recordId, { from: who });
      } catch (err) {
        return this._deny(who, recordId, "on-chain policy denied");
      }
      const owner = this.keystore.ownerOf(rec.contentDigest);
      if (owner && !(await this.crm.consentGiven(owner))) return this._deny(who, recordId, "subject consent withdrawn");
    }
    if (Number(rec.status) !== 0) return this._deny(who, recordId, "record not active");
    if (Number(rec.expiresAt) !== 0 && Number(rec.expiresAt) <= this.nowFn()) return this._deny(who, recordId, "record expired");
    const k = this.keystore.get(rec.contentDigest);
    if (!k) return this._deny(who, recordId, "data key destroyed");
    const ct = await this.storage.get(rec.contentDigest, rec.storageScheme);
    const payload = decryptPayload(ct, k.dek);
    this.audit.append({ decision: "GRANT", who, role: Number(role), recordId: String(recordId) });
    return { recordId: String(recordId), role: Number(role), payload };
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

  async _readAsService(recordId) {
    // Public minimal metadata (no pseudonyms); used to resolve ownership for READ_self.
    return this.crm.recordMeta(recordId);
  }
}

module.exports = { KeyReleaseService, challengeMessage, ROLE };
