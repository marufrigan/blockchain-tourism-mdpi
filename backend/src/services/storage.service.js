/**
 * Content-addressed off-chain storage for ciphertexts.
 * The on-chain contentDigest is SHA-256(ciphertext). Objects are stored under that digest:
 *  - scheme 0 (local): <dataDir>/objects/<digest>.bin
 *  - scheme 1 (ipfs):  a raw IPFS block whose CIDv1 (raw codec, sha2-256) embeds the same digest,
 *                      kept in a Helia node with a filesystem blockstore.
 * Every read recomputes the digest, so a modified object is rejected (tamper detection).
 */
const fs = require("fs");
const path = require("path");
const { sha256Hex } = require("../utils/crypto");

const RAW_CODEC = 0x55;

class StorageService {
  constructor({ dataDir, mode = "local" }) {
    this.dataDir = dataDir;
    this.mode = mode;
    this.objDir = path.join(dataDir, "objects");
    fs.mkdirSync(this.objDir, { recursive: true });
    this.helia = null;
  }

  get scheme() {
    return this.mode === "ipfs" ? 1 : 0;
  }

  async _ipfs() {
    if (!this.helia) {
      const { FsBlockstore } = await import("blockstore-fs");
      const { CID } = await import("multiformats/cid");
      const { sha256 } = await import("multiformats/hashes/sha2");
      const store = new FsBlockstore(path.join(this.dataDir, "ipfs-blocks"));
      await store.open();
      this.helia = { store, CID, sha256 };
    }
    return this.helia;
  }

  /** Compute the IPFS CIDv1 (raw, sha2-256) for a ciphertext. */
  async cidOf(buf) {
    const { CID, sha256 } = await this._ipfs();
    const mh = await sha256.digest(buf);
    return CID.createV1(RAW_CODEC, mh);
  }

  async put(ciphertext) {
    const digest = sha256Hex(ciphertext);
    if (this.mode === "ipfs") {
      const { store } = await this._ipfs();
      const cid = await this.cidOf(ciphertext);
      await store.put(cid, ciphertext);
      return { digest, scheme: 1, ref: `ipfs://${cid.toString()}` };
    }
    fs.writeFileSync(path.join(this.objDir, `${digest.slice(2)}.bin`), ciphertext);
    return { digest, scheme: 0, ref: `local:${digest.slice(2)}` };
  }

  async get(digest, scheme) {
    let buf;
    if (Number(scheme) === 1) {
      const { store, CID } = await this._ipfs();
      const { create } = await import("multiformats/hashes/digest");
      const mh = create(0x12, Buffer.from(digest.slice(2), "hex"));
      const cid = CID.createV1(RAW_CODEC, mh);
      const chunks = [];
      const got = await store.get(cid);
      if (got && typeof got[Symbol.asyncIterator] === "function") {
        for await (const c of got) chunks.push(c);
        buf = Buffer.concat(chunks);
      } else {
        buf = Buffer.from(got);
      }
    } else {
      const p = path.join(this.objDir, `${digest.slice(2)}.bin`);
      if (!fs.existsSync(p)) throw new Error("object not found");
      buf = fs.readFileSync(p);
    }
    if (sha256Hex(buf) !== digest.toLowerCase()) throw new Error("integrity check failed: digest mismatch");
    return buf;
  }

  async close() {
    if (this.helia) await this.helia.store.close();
  }
}

module.exports = { StorageService };
