/* eslint-disable no-unused-expressions */
const assert = require("assert");
const os = require("os");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const ganache = require("ganache");
const { ethers } = require("ethers");
const { deploySystem } = require("../backend/src/lib/contracts");
const { encryptPayload } = require("../backend/src/utils/crypto");
const { subjectPseudonym, venuePseudonym, epochOf } = require("../backend/src/utils/pseudonym");
const { StorageService } = require("../backend/src/services/storage.service");
const { KeyStore } = require("../backend/src/services/keystore.service");
const { AuditLog } = require("../backend/src/services/audit.service");
const { KeyReleaseService, challengeMessage } = require("../backend/src/services/keyRelease.service");
const { matchExposures } = require("../backend/src/services/exposure.service");

const R = { ADMIN: 0, TOURIST: 1, HOTEL: 2, HEALTH: 3, TOURISM: 4 };
const D = { O: 0, V: 1, X: 2, G: 3, C: 4 };

function revertReason(e) {
  const blob = JSON.stringify(e, Object.getOwnPropertyNames(e)) + String(e.message);
  const m = blob.match(/0x08c379a0[0-9a-f]{128}([0-9a-f]+)/i);
  if (m) {
    try {
      return ethers.utils.defaultAbiCoder.decode(["string"], "0x" + m[0].slice(10))[0];
    } catch (_) {}
  }
  return e.reason || e.message;
}

async function reverts(p, msg) {
  try {
    const tx = await p;
    if (tx && tx.wait) await tx.wait();
  } catch (e) {
    const mined = String(e.message).includes("transaction failed");
    if (msg && !mined) {
      const r = revertReason(e);
      assert(String(r).includes(msg) || String(e.message).includes(msg), `expected "${msg}", got ${r}`);
    }
    return;
  }
  assert.fail("expected revert");
}

describe("PCTF contracts and key-release service", function () {
  this.timeout(60000);
  let provider, s, reg, crm, admin, tourist, tourist2, hotel, hotel2, health, tourism, outsider, revoked;
  let storage, keystore, audit, krs, dataDir;
  const pepper = crypto.randomBytes(32);
  const kek = crypto.randomBytes(32);
  const T0 = 1767225600; // 2026-01-01T00:00:00Z

  async function sign(wallet, action, target) {
    const ts = Math.floor(Date.now() / 1000);
    const nonce = crypto.randomBytes(8).toString("hex");
    const signature = await wallet.signMessage(challengeMessage(action, target, ts, nonce));
    return { target, ts, nonce, signature, claimedAddress: wallet.address };
  }

  async function addVenueRecord(hotelSigner, touristWallet, subjectId, venueId, tStart, tEnd, ttl = 0) {
    const payload = { guest: subjectId, venue: venueId, room: "101", checkIn: tStart, checkOut: tEnd };
    const { ciphertext, dek } = encryptPayload(payload);
    const put = await storage.put(ciphertext);
    const sp = subjectPseudonym(pepper, subjectId, epochOf(tStart));
    const vp = venuePseudonym(pepper, venueId);
    const tx = await crm.connect(hotelSigner).createVenueRecord(sp, vp, put.digest, tStart, tEnd, ttl, put.scheme);
    const rc = await tx.wait();
    const id = (await crm.recordCount()).toNumber();
    keystore.put(put.digest, dek, { owner: touristWallet ? touristWallet.address : null, expiresAt: ttl ? (await provider.getBlock(rc.blockNumber)).timestamp + ttl : 0 });
    return { id, digest: put.digest, sp, vp };
  }

  before(async () => {
    const keys = Array.from({ length: 10 }, () => ethers.Wallet.createRandom().privateKey);
    const g = ganache.provider({
      logging: { quiet: true },
      chain: { chainId: 1337 },
      wallet: { accounts: keys.map((k) => ({ secretKey: k, balance: "0x" + (10n ** 21n).toString(16) })) },
    });
    provider = new ethers.providers.Web3Provider(g);
    const w = (i) => new ethers.Wallet(keys[i], provider);
    [admin, tourist, tourist2, hotel, hotel2, health, tourism, outsider, revoked] = [0, 1, 2, 3, 4, 5, 6, 7, 8].map(w);
    s = await deploySystem(admin);
    reg = s.registry.contract;
    crm = s.crm.contract;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pctf-test-"));
    storage = new StorageService({ dataDir, mode: "local" });
    keystore = new KeyStore({ dataDir, kek });
    audit = new AuditLog({ dataDir });
    krs = new KeyReleaseService({ registry: reg, crm: crm.connect(provider), keystore, storage, audit, pepper });
  });

  it("registers stakeholders (admin only) and rejects duplicates", async () => {
    await (await reg.registerParticipant(tourist.address, R.TOURIST, "")).wait();
    await (await reg.registerParticipant(tourist2.address, R.TOURIST, "")).wait();
    await (await reg.registerParticipant(hotel.address, R.HOTEL, "H-01")).wait();
    await (await reg.registerParticipant(hotel2.address, R.HOTEL, "H-02")).wait();
    await (await reg.registerParticipant(health.address, R.HEALTH, "PHA")).wait();
    await (await reg.registerParticipant(tourism.address, R.TOURISM, "DMO")).wait();
    await (await reg.registerParticipant(revoked.address, R.HOTEL, "H-99")).wait();
    await reverts(reg.registerParticipant(tourist.address, R.TOURIST, ""), "already registered");
    await reverts(reg.connect(hotel).registerParticipant(outsider.address, R.HOTEL, ""), "only admin");
  });

  it("revokes and re-assigns roles", async () => {
    await (await reg.revokeParticipant(revoked.address)).wait();
    const [active] = await reg.roleOf(revoked.address);
    assert.equal(active, false);
    await reverts(reg.revokeParticipant(admin.address), "last admin");
  });

  it("policy matrix matches the specification", async () => {
    const yes = [
      [R.TOURIST, D.O, 0], [R.TOURIST, D.X, 0],
      [R.HOTEL, D.V, 0], [R.HOTEL, D.V, 1], [R.HOTEL, D.G, 0],
      [R.HEALTH, D.O, 0], [R.HEALTH, D.O, 1], [R.HEALTH, D.V, 0], [R.HEALTH, D.X, 0], [R.HEALTH, D.X, 1], [R.HEALTH, D.G, 0], [R.HEALTH, D.G, 1],
      [R.TOURISM, D.G, 0], [R.ADMIN, D.C, 0], [R.ADMIN, D.C, 1],
    ];
    let allowed = 0;
    for (let r = 0; r <= 4; r++) for (let d = 0; d <= 4; d++) for (let a = 0; a <= 1; a++) {
      const exp = yes.some((y) => y[0] === r && y[1] === d && y[2] === a);
      assert.equal(await crm.isAllowed(r, d, a), exp, `ρ(${r},${d},${a})`);
      if (exp) allowed++;
    }
    assert.equal(allowed, 15);
  });

  it("only hotels create venue records; revoked and other roles are rejected", async () => {
    const r1 = await addVenueRecord(hotel, tourist, "T-1", "V-1", T0, T0 + 7200);
    assert.equal(r1.id, 1);
    for (const bad of [tourist, health, tourism, admin, outsider, revoked]) {
      await reverts(crm.connect(bad).createVenueRecord(r1.sp, r1.vp, r1.digest, T0, T0 + 1, 0, 0, { gasLimit: 500000 }));
    }
  });

  it("hotels read only their own venue records and never diagnostics", async () => {
    await crm.connect(hotel).getRecord(1);
    await reverts(crm.connect(hotel2).getRecord(1), "not record owner");
    await reverts(crm.connect(tourism).getRecord(1), "unauthorized");
    await reverts(crm.connect(admin).getRecord(1), "unauthorized");
  });

  it("only health authorities record diagnoses and exposure notices", async () => {
    const sp = subjectPseudonym(pepper, "T-1", epochOf(T0 + 86400 * 3));
    const { ciphertext, dek } = encryptPayload({ patient: "T-1", test: "PCR+" });
    const put = await storage.put(ciphertext);
    await reverts(crm.connect(hotel).recordDiagnosis(sp, put.digest, T0 + 86400 * 3, 86400 * 10, 0, 0, { gasLimit: 500000 }), "unauthorized");
    await (await crm.connect(health).recordDiagnosis(sp, put.digest, T0 + 86400 * 3, 86400 * 10, 0, 0)).wait();
    keystore.put(put.digest, dek, { owner: tourist.address });
    await reverts(crm.connect(hotel).getRecord(2), "unauthorized");
    await reverts(crm.connect(tourism).notifyExposures(2, [sp], { gasLimit: 500000 }), "unauthorized");
  });

  it("matches exposures from on-chain data and notifies exposed pseudonyms", async () => {
    // tourist2 overlaps with T-1 at V-1; a third guest at another time does not
    await addVenueRecord(hotel, tourist2, "T-2", "V-1", T0 + 3600, T0 + 10800);
    await addVenueRecord(hotel, null, "T-3", "V-1", T0 + 86400, T0 + 90000);
    const tD = T0 + 86400 * 3;
    const pseud = await krs.pseudonymsForDiagnosis(await sign(health, "diagnosis-pseudonyms", "T-1"), "T-1", tD - 86400 * 10, tD);
    const m = await matchExposures(crm.connect(health), pseud, tD - 86400 * 10, tD);
    assert.deepEqual(m.exposed, [subjectPseudonym(pepper, "T-2", epochOf(T0 + 3600)).toLowerCase()]);
    await (await crm.connect(health).notifyExposures(2, m.exposed)).wait();
    const own = await krs.ownPseudonyms(await sign(tourist2, "pseudonyms", "self"), T0, T0 + 86400 * 2).catch((e) => e);
    assert(own instanceof Error); // tourist2 not enrolled yet
    krs.enrolTourist(tourist2.address, "T-2");
    const mine = await krs.ownPseudonyms(await sign(tourist2, "pseudonyms", "self"), T0, T0 + 86400 * 2);
    let hit = 0;
    for (const p of mine) if ((await crm.connect(tourist2).getExposure(p)).toNumber() === 2) hit++;
    assert.equal(hit, 1);
  });

  it("key release enforces policy, ownership, consent and replay protection", async () => {
    await (await crm.connect(tourist).setConsent(true)).wait();
    await (await crm.connect(tourist2).setConsent(true)).wait();
    const ok = await krs.release(await sign(health, "release", "1"));
    assert.equal(ok.payload.guest, "T-1");
    const own = await krs.release(await sign(tourist, "release", "1"));
    assert.equal(own.payload.venue, "V-1");
    await reverts(krs.release(await sign(tourist2, "release", "1")), "own records");
    await reverts(krs.release(await sign(tourism, "release", "1")), "policy denied");
    await reverts(krs.release(await sign(hotel2, "release", "1")), "policy denied");
    await reverts(krs.release(await sign(hotel, "release", "2")), "policy denied");
    const replay = await sign(health, "release", "1");
    await krs.release(replay);
    await reverts(krs.release(replay), "replayed");
    const forged = await sign(outsider, "release", "1");
    forged.claimedAddress = health.address;
    await reverts(krs.release(forged), "does not match");
  });

  it("consent withdrawal crypto-shreds only that tourist's objects", async () => {
    await (await crm.connect(tourist).setConsent(false)).wait();
    const n = krs.onConsentWithdrawn(tourist.address);
    assert.equal(n, 2);
    await reverts(krs.release(await sign(health, "release", "1")), "data key destroyed");
    const other = await krs.release(await sign(health, "release", "3"));
    assert.equal(other.payload.guest, "T-2");
  });

  it("detects off-chain tampering through the on-chain digest", async () => {
    const meta = await crm.recordMeta(3);
    const f = path.join(dataDir, "objects", meta.contentDigest.slice(2) + ".bin");
    const b = fs.readFileSync(f);
    b[b.length - 1] ^= 0xff;
    fs.writeFileSync(f, b);
    await reverts(krs.release(await sign(health, "release", "3")), "integrity");
  });

  it("audit log is hash-chained and records denials", async () => {
    const v = audit.verify();
    assert(v.ok && v.entries > 5);
    const lines = fs.readFileSync(path.join(dataDir, "audit.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert(lines.some((l) => l.decision === "DENY"));
  });

  it("view-function checks are not confidentiality: eth_call can spoof `from`", async () => {
    // Documented limitation: any node user can read public metadata by spoofing `from`.
    const r = await crm.connect(provider).getRecord(1, { from: health.address });
    assert.equal(r.createdBy, hotel.address);
  });
});
