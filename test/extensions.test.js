/* Matching rule, replay across restarts and fail-closed behaviour of the key-release service. */
const assert = require("assert");
const os = require("os");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { ethers } = require("ethers");
const { overlaps, signedOverlap } = require("../backend/src/services/exposure.service");
const { KeyReleaseService, challengeMessage } = require("../backend/src/services/keyRelease.service");
const { encryptPayload } = require("../backend/src/utils/crypto");

describe("matching rule (closed intervals, signed overlap)", () => {
  it("endpoint-only contact qualifies at theta = 0", () => {
    assert.strictEqual(signedOverlap(100, 200, 200, 300), 0);
    assert.ok(overlaps(100, 200, 200, 300));
  });
  it("intervals one second apart do not match", () => {
    assert.strictEqual(signedOverlap(100, 199, 200, 300), -1);
    assert.ok(!overlaps(100, 199, 200, 300));
  });
  it("theta > 0 requires that much shared time", () => {
    assert.ok(overlaps(0, 1000, 400, 2000, 600));
    assert.ok(!overlaps(0, 1000, 401, 2000, 600));
  });
  it("an empty clipped window never matches", () => {
    // visit [10, 20] lies before the window [30, 40]: the clipped interval [30, 20] is empty
    const vs = Math.max(10, 30);
    const ve = Math.min(20, 40);
    assert.ok(!overlaps(10, 20, 30, 40));
    assert.ok(!overlaps(25, 35, vs, ve)); // even a stay that overlaps the window is not matched against it
  });
});

function mockService(extra = {}) {
  const w = ethers.Wallet.createRandom();
  const enc = encryptPayload({ ok: 1 });
  const rec = { contentDigest: "0x" + crypto.createHash("sha256").update(enc.ciphertext).digest("hex"), dataType: 1, status: 0, storageScheme: 0, expiresAt: 0 };
  const base = {
    registry: { roleOf: async () => [true, 3] },
    crm: { getRecord: async () => rec, consentGiven: async () => true, recordMeta: async () => rec },
    keystore: { ownerOf: () => null, get: () => ({ dek: enc.dek }) },
    storage: { get: async () => enc.ciphertext },
    audit: { append: () => {} },
    pepper: "p",
  };
  return { w, opts: { ...base, ...extra } };
}
async function signed(w) {
  const ts = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(12).toString("hex");
  return { target: "1", ts, nonce, signature: await w.signMessage(challengeMessage("release", "1", ts, nonce)), claimedAddress: w.address };
}

describe("key-release service hardening", () => {
  it("rejects a replay after a restart when the nonce log is kept", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pctf-nl-"));
    const { w, opts } = mockService({ nonceLog: path.join(dir, "nonces.log") });
    const a = await signed(w);
    await new KeyReleaseService(opts).release({ ...a });
    await assert.rejects(new KeyReleaseService(opts).release({ ...a }), /replayed/);
    // without the log the restarted service would accept it: the window the log closes
    await new KeyReleaseService({ ...opts, nonceLog: null }).release({ ...a });
  });
  it("grants at most one of many concurrent copies of a challenge", async () => {
    const { w, opts } = mockService();
    const krs = new KeyReleaseService(opts);
    const a = await signed(w);
    const r = await Promise.all(Array.from({ length: 32 }, () => krs.release({ ...a }).then(() => 1, () => 0)));
    assert.strictEqual(r.reduce((x, y) => x + y, 0), 1);
  });
  it("fails closed when the chain cannot be read", async () => {
    const { w, opts } = mockService({ registry: { roleOf: async () => { throw new Error("ECONNREFUSED"); } } });
    await assert.rejects(new KeyReleaseService(opts).release(await signed(w)), /chain unavailable/);
  });
  it("denies and audits a missing or corrupted object", async () => {
    const log = [];
    const { w, opts } = mockService({ storage: { get: async () => { throw new Error("integrity check failed: digest mismatch"); } }, audit: { append: (e) => log.push(e) } });
    await assert.rejects(new KeyReleaseService(opts).release(await signed(w)), /integrity/);
    assert.strictEqual(log[0].decision, "DENY");
  });
  it("rejects malformed nonces", async () => {
    const { w, opts } = mockService();
    const a = await signed(w);
    a.nonce = "x y";
    await assert.rejects(new KeyReleaseService(opts).release(a), /malformed/);
  });
});
