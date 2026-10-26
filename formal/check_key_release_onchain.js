/**
 * Differential check of the in-memory chain model used by check_key_release.js.
 * Runs the same 1,728 cases (9 requesters x 2 record types x 3 statuses x expiry x key presence
 * x consent x 4 authentication outcomes), but against the deployed ParticipantRegistry and
 * ContactRecordManager on a local EVM, with the real key store and object store. Every decision
 * is compared with the formal rule delta_KR and with the decision of the in-memory model
 * (results/e13_key_release_exhaustive.csv), case by case.
 *
 * Usage: node formal/check_key_release_onchain.js [results_dir]
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { ethers } = require("ethers");
const ganache = require("ganache");
const { deploySystem } = require("../backend/src/lib/contracts");
const { encryptPayload } = require("../backend/src/utils/crypto");
const { StorageService } = require("../backend/src/services/storage.service");
const { KeyStore } = require("../backend/src/services/keystore.service");
const { AuditLog } = require("../backend/src/services/audit.service");
const { KeyReleaseService, challengeMessage } = require("../backend/src/services/keyRelease.service");

const ROLE = { ADMIN: 0, TOURIST: 1, HOTEL: 2, HEALTH: 3, TOURISM: 4 };
const GRANTS = [[1, 0, 0], [1, 2, 0], [2, 1, 0], [2, 1, 1], [2, 3, 0], [3, 0, 0], [3, 0, 1], [3, 1, 0], [3, 2, 0], [3, 2, 1], [3, 3, 0], [3, 3, 1], [4, 3, 0], [0, 4, 0], [0, 4, 1]];
const rho = (r, d, a) => GRANTS.some(([x, y, z]) => x === r && y === d && z === a);
const seedKey = (s) => ethers.utils.keccak256(ethers.utils.toUtf8Bytes(s));
const NAMES = { admin: "admin", touristOwner: "t-owner", touristOther: "t-other", hotelCreator: "h-creator", hotelOther: "h-other", health: "health", tourism: "tourism", revokedHotel: "h-revoked", unregistered: "nobody" };
const REG = { touristOwner: ROLE.TOURIST, touristOther: ROLE.TOURIST, hotelCreator: ROLE.HOTEL, hotelOther: ROLE.HOTEL, health: ROLE.HEALTH, tourism: ROLE.TOURISM, revokedHotel: ROLE.HOTEL };

(async () => {
  const out = process.argv[2] || "results";
  const keys = Object.fromEntries(Object.entries(NAMES).map(([k, s]) => [k, seedKey(s)]));
  const server = ganache.server({
    logging: { quiet: true },
    chain: { chainId: 1337, hardfork: "shanghai" },
    miner: { blockGasLimit: 30_000_000, instamine: "eager" },
    wallet: { accounts: Object.values(keys).map((k) => ({ secretKey: k, balance: "0x" + (10n ** 22n).toString(16) })) },
  });
  await new Promise((r) => server.listen(18790, r));
  const provider = new ethers.providers.JsonRpcProvider("http://127.0.0.1:18790");
  provider.pollingInterval = 20;
  const W = Object.fromEntries(Object.entries(keys).map(([k, s]) => [k, new ethers.Wallet(s, provider)]));
  const sys = await deploySystem(W.admin);
  const reg = sys.registry.contract;
  const crm = sys.crm.contract;
  for (const [k, role] of Object.entries(REG)) await (await reg.registerParticipant(W[k].address, role, k)).wait();
  await (await reg.revokeParticipant(W.revokedHotel.address)).wait();

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pctf-diff-"));
  const storage = new StorageService({ dataDir, mode: "local" });
  const keystore = new KeyStore({ dataDir, kek: crypto.randomBytes(32) });
  const audit = new AuditLog({ dataDir });

  // 12 records: data type x status x expiry; all linked to touristOwner
  const recs = [];
  for (const dataType of [1, 2])
    for (const status of [0, 1, 2])
      for (const expired of [false, true]) {
        const { ciphertext, dek } = encryptPayload({ dataType, status, expired });
        const put = await storage.put(ciphertext);
        const sp = ethers.utils.hexlify(crypto.randomBytes(32));
        const ttl = expired ? 1 : 0;
        if (dataType === 1) await (await crm.connect(W.hotelCreator).createVenueRecord(sp, ethers.utils.hexlify(crypto.randomBytes(32)), put.digest, 1772409600, 1772413200, ttl, 0)).wait();
        else await (await crm.connect(W.health).recordDiagnosis(sp, put.digest, 1772409600 + 864000, 864000, ttl, 0)).wait();
        const id = (await crm.recordCount()).toNumber();
        if (status !== 0) await (await crm.connect(dataType === 1 ? W.hotelCreator : W.health).updateRecordStatus(id, status)).wait();
        keystore.put(put.digest, dek, { owner: W.touristOwner.address });
        recs.push({ id, dataType, status, expired, digest: put.digest, dek });
      }
  await provider.send("evm_increaseTime", [30]);
  await provider.send("evm_mine", []);
  let chainNow = (await provider.getBlock("latest")).timestamp;
  const krs = new KeyReleaseService({ registry: reg.connect(provider), crm: crm.connect(provider), keystore, storage, audit, pepper: "p", nowFn: () => chainNow });

  // decisions of the in-memory model, if available
  const modelFile = path.join(out, "e13_key_release_exhaustive.csv");
  const model = new Map();
  if (fs.existsSync(modelFile)) {
    const [h, ...rows] = fs.readFileSync(modelFile, "utf8").trim().split("\n");
    const cols = h.split(",");
    for (const r of rows) {
      const o = Object.fromEntries(r.split(",").map((v, i) => [cols[i], v]));
      model.set([o.requester, o.dataType, o.status, o.expired, o.keyPresent, o.consent, o.auth].join("|"), o.granted === "true");
    }
  }

  const res = [];
  for (const consent of [true, false]) {
    await (await crm.connect(W.touristOwner).setConsent(consent)).wait();
    chainNow = (await provider.getBlock("latest")).timestamp;
    for (const rec of recs)
      for (const keyPresent of [true, false]) {
        if (!keyPresent) keystore.destroy(rec.digest);
        for (const requester of Object.keys(NAMES))
          for (const auth of ["valid", "forged", "replay", "stale"]) {
            const signer = W[requester];
            const ts = auth === "stale" ? chainNow - 600 : chainNow;
            const nonce = crypto.randomBytes(12).toString("hex");
            const sigWallet = auth === "forged" ? new ethers.Wallet(seedKey("attacker")) : signer;
            const signature = await sigWallet.signMessage(challengeMessage("release", String(rec.id), ts, nonce));
            const req = { target: String(rec.id), ts, nonce, signature, claimedAddress: signer.address };
            if (auth === "replay") await krs.release({ ...req }).catch(() => {});
            const granted = await krs.release({ ...req }).then((r) => Boolean(r && r.payload && r.payload.dataType === rec.dataType), () => false);
            const role = requester in REG ? REG[requester] : 0;
            const active = requester in REG && requester !== "revokedHotel" || requester === "admin";
            let branch;
            if (role === ROLE.TOURIST && active) branch = requester === "touristOwner";
            else branch = rho(role, rec.dataType, 0) && (role !== ROLE.HOTEL || requester === "hotelCreator") && consent;
            const expected = auth === "valid" && active && branch && rec.status === 0 && !rec.expired && keyPresent;
            const key = [requester, rec.dataType, rec.status, rec.expired, keyPresent, consent, auth].join("|");
            const m = model.has(key) ? model.get(key) : null;
            res.push({ requester, dataType: rec.dataType, status: rec.status, expired: rec.expired, keyPresent, consent, auth, granted, expected, agreeRule: granted === expected, model: m, agreeModel: m === null ? "" : m === granted });
          }
        if (!keyPresent) keystore.put(rec.digest, rec.dek, { owner: W.touristOwner.address });
      }
  }
  const cols = Object.keys(res[0]);
  fs.writeFileSync(path.join(out, "e13_key_release_onchain.csv"), [cols.join(","), ...res.map((r) => cols.map((k) => r[k]).join(","))].join("\n"));
  const s = {
    cases: res.length,
    agreeWithRule: res.filter((r) => r.agreeRule).length,
    agreeWithInMemoryModel: res.filter((r) => r.agreeModel === true).length,
    comparedWithModel: res.filter((r) => r.agreeModel !== "").length,
    granted: res.filter((r) => r.granted).length,
  };
  console.log(JSON.stringify(s));
  await server.close();
  process.exit(s.agreeWithRule === s.cases ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
