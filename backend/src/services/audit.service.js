/**
 * Append-only, hash-chained audit log for key-release decisions (granted and denied).
 * Reverted transactions cannot emit events, so denied attempts are logged here. Each entry
 * stores the hash of the previous entry; editing or deleting a line breaks the chain.
 * The latest head hash can be anchored on-chain periodically.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

class AuditLog {
  constructor({ dataDir }) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, "audit.log");
    this.head = "0x" + "0".repeat(64);
    if (fs.existsSync(this.file)) {
      const lines = fs.readFileSync(this.file, "utf8").trim().split("\n").filter(Boolean);
      if (lines.length) this.head = JSON.parse(lines[lines.length - 1]).hash;
    }
  }

  append(entry) {
    const body = { ts: Date.now(), ...entry, prev: this.head };
    const hash = "0x" + crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex");
    fs.appendFileSync(this.file, JSON.stringify({ ...body, hash }) + "\n");
    this.head = hash;
    return hash;
  }

  verify() {
    if (!fs.existsSync(this.file)) return { ok: true, entries: 0 };
    const lines = fs.readFileSync(this.file, "utf8").trim().split("\n").filter(Boolean);
    let prev = "0x" + "0".repeat(64);
    for (let i = 0; i < lines.length; i++) {
      const { hash, ...body } = JSON.parse(lines[i]);
      if (body.prev !== prev) return { ok: false, brokenAt: i };
      const h = "0x" + crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex");
      if (h !== hash) return { ok: false, brokenAt: i };
      prev = hash;
    }
    return { ok: true, entries: lines.length };
  }
}

module.exports = { AuditLog };
