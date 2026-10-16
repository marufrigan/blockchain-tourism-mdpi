/**
 * Key store of the key-release service. Holds one wrapped DEK per off-chain object
 * (indexed by content digest) plus the off-chain link from a tourist wallet to the digests
 * that concern that tourist. Destroying an entry is the crypto-shredding operation.
 */
const fs = require("fs");
const path = require("path");
const { wrapKey, unwrapKey } = require("../utils/crypto");

class KeyStore {
  constructor({ dataDir, kek }) {
    this.file = path.join(dataDir, "keystore.json");
    this.kek = kek;
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, "utf8")) : { keys: {}, owners: {} };
    this.dirty = false;
  }

  _save() {
    fs.writeFileSync(this.file, JSON.stringify(this.db));
    this.dirty = false;
  }

  put(digest, dek, { owner, expiresAt = 0 } = {}, persist = true) {
    const d = digest.toLowerCase();
    this.db.keys[d] = { w: wrapKey(this.kek, dek, d).toString("base64"), owner: owner ? owner.toLowerCase() : null, expiresAt };
    if (owner) {
      const o = owner.toLowerCase();
      (this.db.owners[o] = this.db.owners[o] || []).push(d);
    }
    if (persist) this._save();
    else this.dirty = true;
  }

  flush() {
    if (this.dirty) this._save();
  }

  get(digest) {
    const e = this.db.keys[digest.toLowerCase()];
    if (!e) return null;
    return { dek: unwrapKey(this.kek, Buffer.from(e.w, "base64"), digest.toLowerCase()), owner: e.owner, expiresAt: e.expiresAt };
  }

  ownerOf(digest) {
    const e = this.db.keys[digest.toLowerCase()];
    return e ? e.owner : null;
  }

  has(digest) {
    return Boolean(this.db.keys[digest.toLowerCase()]);
  }

  digestsOf(owner) {
    return (this.db.owners[owner.toLowerCase()] || []).filter((d) => this.db.keys[d]);
  }

  destroy(digest) {
    const d = digest.toLowerCase();
    const existed = Boolean(this.db.keys[d]);
    delete this.db.keys[d];
    this._save();
    return existed;
  }

  /** Crypto-shred every object linked to a tourist (consent withdrawal / erasure request). */
  destroyAllOf(owner) {
    const list = this.digestsOf(owner);
    for (const d of list) delete this.db.keys[d];
    this._save();
    return list.length;
  }

  /** Retention: shred keys whose expiry has passed. */
  purgeExpired(nowTs) {
    let n = 0;
    for (const [d, e] of Object.entries(this.db.keys)) {
      if (e.expiresAt && e.expiresAt <= nowTs) {
        delete this.db.keys[d];
        n++;
      }
    }
    this._save();
    return n;
  }
}

module.exports = { KeyStore };
