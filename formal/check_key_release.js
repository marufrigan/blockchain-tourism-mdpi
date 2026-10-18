/**
 * Exhaustive conformance check of the key-release service (Theorem 4).
 * Runs the real KeyReleaseService over every combination of requester, record type,
 * record status, expiry, key presence, subject consent and authentication outcome, with the
 * chain replaced by an in-memory model of ParticipantRegistry and ContactRecordManager
 * (same policy bits, same getRecord checks), and compares every decision with the formal rule
 *
 *   delta_KR(pk, i) = Auth(sigma) and active(pk) and
 *       [ (phi(pk) = tourist and owner(h_i) = pk)
 *       or (phi(pk) != tourist and rho(phi(pk), type_i, READ) and (phi(pk) = hotel => creator_i = pk)
 *           and consent(owner(h_i))) ]
 *       and status_i = active and not expired_i and key(h_i) exists.
 *
 * Usage: node formal/check_key_release.js [results_dir]
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { ethers } = require("ethers");
const { KeyReleaseService, challengeMessage } = require("../backend/src/services/keyRelease.service");
const { encryptPayload } = require("../backend/src/utils/crypto");

const ROLE = { ADMIN: 0, TOURIST: 1, HOTEL: 2, HEALTH: 3, TOURISM: 4 };
const READ = 0;
const GRANTS = [[1, 0, 0], [1, 2, 0], [2, 1, 0], [2, 1, 1], [2, 3, 0], [3, 0, 0], [3, 0, 1], [3, 1, 0], [3, 2, 0], [3, 2, 1], [3, 3, 0], [3, 3, 1], [4, 3, 0], [0, 4, 0], [0, 4, 1]];
let BITS = 0n;
for (const [r, d, a] of GRANTS) BITS |= 1n << BigInt(r * 10 + d * 2 + a);
const rho = (r, d, a) => ((BITS >> BigInt(r * 10 + d * 2 + a)) & 1n) === 1n;

const wallet = (seed) => new ethers.Wallet(ethers.utils.keccak256(ethers.utils.toUtf8Bytes(seed)));
const W = {
  admin: wallet("admin"), touristOwner: wallet("t-owner"), touristOther: wallet("t-other"),
  hotelCreator: wallet("h-creator"), hotelOther: wallet("h-other"), health: wallet("health"),
  tourism: wallet("tourism"), revokedHotel: wallet("h-revoked"), unregistered: wallet("nobody"),
};
const reg = new Map([
  [W.admin.address, [true, ROLE.ADMIN]], [W.touristOwner.address, [true, ROLE.TOURIST]],
  [W.touristOther.address, [true, ROLE.TOURIST]], [W.hotelCreator.address, [true, ROLE.HOTEL]],
  [W.hotelOther.address, [true, ROLE.HOTEL]], [W.health.address, [true, ROLE.HEALTH]],
  [W.tourism.address, [true, ROLE.TOURISM]], [W.revokedHotel.address, [false, ROLE.HOTEL]],
]);
const roleOf = (a) => reg.get(ethers.utils.getAddress(a)) || [false, 0];

async function runCase(c) {
  const enc = encryptPayload({ case: c.id });
  const digest = "0x" + crypto.createHash("sha256").update(enc.ciphertext).digest("hex");
  const now = 1_800_000_000;
  const rec = { contentDigest: digest, dataType: c.dataType, status: c.status, storageScheme: 0, expiresAt: c.expired ? now - 10 : 0, createdBy: W.hotelCreator.address };
  const registry = { roleOf: async (a) => roleOf(a) };
  const crm = {
    recordMeta: async () => rec,
    consentGiven: async () => c.consent,
    // mirrors ContactRecordManager.getRecord: _authorize(READ), hotel ownership, tourists redirected
    getRecord: async (_id, { from }) => {
      const [active, role] = roleOf(from);
      if (!active) throw new Error("RBAC: not registered");
      if (!rho(role, rec.dataType, READ)) throw new Error("RBAC: unauthorized");
      if (role === ROLE.HOTEL && ethers.utils.getAddress(rec.createdBy) !== ethers.utils.getAddress(from)) throw new Error("CRM: not record owner");
      if (role === ROLE.TOURIST) throw new Error("CRM: use key service");
      return rec;
    },
  };
  const keystore = {
    ownerOf: () => W.touristOwner.address.toLowerCase(),
    get: () => (c.keyPresent ? { dek: enc.dek } : null),
  };
  const storage = { get: async () => enc.ciphertext };
  const audit = { append: () => {} };
  const krs = new KeyReleaseService({ registry, crm, keystore, storage, audit, pepper: "p", nowFn: () => now });

  const signer = W[c.requester];
  let ts = now;
  let nonce = crypto.randomBytes(12).toString("hex");
  if (c.auth === "stale") ts = now - 600;
  let sigWallet = signer;
  if (c.auth === "forged") sigWallet = wallet("attacker");
  const signature = await sigWallet.signMessage(challengeMessage("release", "1", ts, nonce));
  const req = { target: "1", ts, nonce, signature, claimedAddress: signer.address };
  if (c.auth === "replay") {
    // first use of the nonce is accepted or rejected on its merits; the measured request reuses it
    try { await krs.release(req); } catch (_) {}
  }
  let granted = false;
  try {
    const r = await krs.release(req);
    granted = Boolean(r && r.payload && r.payload.case === c.id);
  } catch (_) {
    granted = false;
  }

  // formal rule
  const [active, role] = roleOf(signer.address);
  const authOk = c.auth === "valid";
  const isOwner = c.requester === "touristOwner";
  let branch;
  if (role === ROLE.TOURIST) branch = isOwner;
  else branch = rho(role, c.dataType, READ) && (role !== ROLE.HOTEL || c.requester === "hotelCreator") && c.consent;
  const expected = authOk && active && branch && c.status === 0 && !c.expired && c.keyPresent;
  return { ...c, granted, expected, agree: granted === expected };
}

(async () => {
  const cases = [];
  let id = 0;
  for (const requester of Object.keys(W))
    for (const dataType of [1, 2])
      for (const status of [0, 1, 2])
        for (const expired of [false, true])
          for (const keyPresent of [true, false])
            for (const consent of [true, false])
              for (const auth of ["valid", "forged", "replay", "stale"])
                cases.push({ id: ++id, requester, dataType, status, expired, keyPresent, consent, auth });
  const res = [];
  for (const c of cases) res.push(await runCase(c));
  const out = process.argv[2] || "results";
  const cols = Object.keys(res[0]);
  fs.writeFileSync(path.join(out, "e13_key_release_exhaustive.csv"), [cols.join(","), ...res.map((r) => cols.map((k) => r[k]).join(","))].join("\n"));
  const s = { cases: res.length, agree: res.filter((r) => r.agree).length, granted: res.filter((r) => r.granted).length, grantedByRequester: {} };
  for (const r of res) if (r.granted) s.grantedByRequester[r.requester] = (s.grantedByRequester[r.requester] || 0) + 1;
  console.log(JSON.stringify(s));
  if (s.agree !== s.cases) process.exit(1);
})();
