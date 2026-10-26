/**
 * Centralised baseline (evaluation only). One trusted operator runs the record index, the same
 * role registry and 64-bit policy matrix, the same envelope encryption, the same signed-challenge
 * key release (the KeyReleaseService code, unchanged) and a hash-chained audit log in which every
 * entry is also signed with the operator's Ed25519 key. There is no ledger: the index and the
 * registry live in the operator's database (an append-only JSON-lines file here).
 *
 * What it shows: the same decisions can be made without a blockchain, faster, but every
 * guarantee then rests on the operator. The operator can rewrite the index or the audit log
 * and re-sign it, and a verifier holding only the operator's public key cannot tell.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { KeyReleaseService } = require("../services/keyRelease.service");

const R = { ADMIN: 0, TOURIST: 1, HOTEL: 2, HEALTH: 3, TOURISM: 4 };
// Same default grants as RoleAccessControl.sol
const GRANTS = [[1, 0, 0], [1, 2, 0], [2, 1, 0], [2, 1, 1], [2, 3, 0], [3, 0, 0], [3, 0, 1], [3, 1, 0], [3, 2, 0], [3, 2, 1], [3, 3, 0], [3, 3, 1], [4, 3, 0], [0, 4, 0], [0, 4, 1]];

class SignedAuditLog {
  constructor({ dataDir, privateKey }) {
    this.file = path.join(dataDir, "central-audit.log");
    this.key = privateKey;
    this.head = "0x" + "0".repeat(64);
    this.count = 0;
  }
  static hashOf(body) {
    return "0x" + crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex");
  }
  append(entry) {
    const body = { ts: Date.now(), ...entry, prev: this.head };
    const hash = SignedAuditLog.hashOf(body);
    const sig = crypto.sign(null, Buffer.from(hash.slice(2), "hex"), this.key).toString("base64");
    fs.appendFileSync(this.file, JSON.stringify({ ...body, hash, sig }) + "\n");
    this.head = hash;
    this.count++;
    return hash;
  }
  lines() {
    return fs.existsSync(this.file) ? fs.readFileSync(this.file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  }
  /** Verification by a third party that holds only the operator public key. */
  static verify(lines, publicKey) {
    let prev = "0x" + "0".repeat(64);
    for (let i = 0; i < lines.length; i++) {
      const { hash, sig, ...body } = lines[i];
      if (body.prev !== prev || SignedAuditLog.hashOf(body) !== hash) return { ok: false, brokenAt: i };
      if (!crypto.verify(null, Buffer.from(hash.slice(2), "hex"), publicKey, Buffer.from(sig, "base64"))) return { ok: false, badSignatureAt: i };
      prev = hash;
    }
    return { ok: true, entries: lines.length, head: prev };
  }
  /** The operator rewrites history: drop entry i, re-chain and re-sign everything after it. */
  rewriteWithout(i) {
    const kept = this.lines().filter((_, k) => k !== i);
    let prev = "0x" + "0".repeat(64);
    const out = kept.map(({ hash, sig, ...body }) => {
      const b = { ...body, prev };
      const h = SignedAuditLog.hashOf(b);
      prev = h;
      return { ...b, hash: h, sig: crypto.sign(null, Buffer.from(h.slice(2), "hex"), this.key).toString("base64") };
    });
    fs.writeFileSync(this.file, out.map((l) => JSON.stringify(l)).join("\n") + "\n");
    this.head = prev;
    this.count = out.length;
    return out;
  }
}

class CentralRecordService {
  constructor({ dataDir, keystore, storage, pepper, nowFn }) {
    fs.mkdirSync(dataDir, { recursive: true });
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
    this.publicKey = publicKey;
    this.audit = new SignedAuditLog({ dataDir, privateKey });
    this.db = path.join(dataDir, "central-db.jsonl");
    this.roles = new Map();
    this.consent = new Map();
    this.records = [null];
    this.policy = new Set(GRANTS.map(([r, d, a]) => `${r}:${d}:${a}`));
    const self = this;
    const roleOf = (a) => self.roles.get(String(a).toLowerCase()) || [false, 0];
    // Adapters with the same interface as the contracts, so KeyReleaseService runs unchanged.
    this.registry = { roleOf: async (a) => roleOf(a) };
    this.crm = {
      recordMeta: async (id) => self._rec(id),
      consentGiven: async (a) => Boolean(self.consent.get(String(a).toLowerCase())),
      getRecord: async (id, { from }) => {
        const r = self._rec(id);
        const [active, role] = roleOf(from);
        if (!active) throw new Error("not registered");
        if (!self.policy.has(`${role}:${r.dataType}:0`)) throw new Error("unauthorized");
        if (role === R.HOTEL && r.createdBy !== String(from).toLowerCase()) throw new Error("not record owner");
        if (role === R.TOURIST) throw new Error("use key service");
        return r;
      },
    };
    this.krs = new KeyReleaseService({ registry: this.registry, crm: this.crm, keystore, storage, audit: this.audit, pepper, nowFn });
  }
  _rec(id) {
    const r = this.records[Number(id)];
    if (!r) throw new Error("invalid id");
    return r;
  }
  _persist(op) {
    fs.appendFileSync(this.db, JSON.stringify(op) + "\n");
  }
  _can(who, d, a) {
    const [active, role] = this.roles.get(who.toLowerCase()) || [false, 0];
    if (!active || !this.policy.has(`${role}:${d}:${a}`)) throw new Error("unauthorized");
    return role;
  }
  register(admin, who, role) {
    if (admin) this._can(admin, 4, 1);
    this.roles.set(who.toLowerCase(), [true, role]);
    this._persist({ op: "register", who: who.toLowerCase(), role });
    this.audit.append({ op: "register", who: who.toLowerCase(), role });
  }
  revoke(admin, who) {
    this._can(admin, 4, 1);
    const [, role] = this.roles.get(who.toLowerCase());
    this.roles.set(who.toLowerCase(), [false, role]);
    this._persist({ op: "revoke", who: who.toLowerCase() });
    this.audit.append({ op: "revoke", who: who.toLowerCase() });
  }
  setConsent(who, given) {
    this.consent.set(who.toLowerCase(), given);
    this._persist({ op: "consent", who: who.toLowerCase(), given });
    this.audit.append({ op: "consent", who: who.toLowerCase(), given });
  }
  createVenueRecord(hotel, { subjectHash, venueHash, contentDigest, tStart, tEnd }) {
    this._can(hotel, 1, 1);
    const r = { subjectHash, venueHash, contentDigest, createdBy: hotel.toLowerCase(), dataType: 1, status: 0, storageScheme: 0, tStart, tEnd, expiresAt: 0 };
    this.records.push(r);
    const id = this.records.length - 1;
    this._persist({ op: "record", id, ...r });
    this.audit.append({ op: "record", id, digest: contentDigest });
    return id;
  }
}

module.exports = { CentralRecordService, SignedAuditLog, R };
