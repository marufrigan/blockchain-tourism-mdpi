/**
 * Extended evaluation (E14 to E18, E20). Each part starts its own Ganache chain.
 *   node scripts/experiments/extended.js [baselines|scale|concurrency|failures|linkage|all]
 * Writes results/e14_*.csv ... results/e20_*.csv and merges keys E14..E20 into results/summary.json.
 * The multi-node experiments (E15 throughput, E19 revocation delay, validator faults) run on
 * a four-validator Besu QBFT network: scripts/experiments/besu-qbft.js.
 */
const fs = require("fs");
const os = require("os");
const net = require("net");
const path = require("path");
const crypto = require("crypto");
const { ethers } = require("ethers");
const { deploySystem, deploy } = require("../../backend/src/lib/contracts");
const { encryptPayload, sha256Hex } = require("../../backend/src/utils/crypto");
const { subjectPseudonym, venuePseudonym, epochOf, subjectPseudonymsInWindow } = require("../../backend/src/utils/pseudonym");
const { StorageService } = require("../../backend/src/services/storage.service");
const { KeyStore } = require("../../backend/src/services/keystore.service");
const { AuditLog } = require("../../backend/src/services/audit.service");
const { KeyReleaseService, challengeMessage } = require("../../backend/src/services/keyRelease.service");
const { matchExposures, signedOverlap } = require("../../backend/src/services/exposure.service");
const { CentralRecordService, SignedAuditLog } = require("../../backend/src/baselines/central.service");
const { rng, stats, writeCsv, mergeSummary, buildWorkload, startGanache, Sender, ms, now, sleep } = require("./lib");

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const keysN = (n) => Array.from({ length: n }, () => ethers.Wallet.createRandom().privateKey);
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

async function sign(wallet, action, target) {
  const ts = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(12).toString("hex");
  const signature = await wallet.signMessage(challengeMessage(action, target, ts, nonce));
  return { target: String(target), ts, nonce, signature, claimedAddress: wallet.address };
}
const tryRelease = (krs, auth) => krs.release(auth).then(() => "GRANT", (e) => e.message.replace(/^denied: /, ""));

/** Builds a PCTF deployment with N encrypted venue records owned by `hotels` hotels. */
async function pctfFixture({ port, N = 300, hotels = 10, healths = 4, tourists = 50, withIpfs = false, nonceLog = false, blockTime = 0 }) {
  const keys = keysN(1 + hotels + healths + tourists + 8);
  const { server, provider } = await startGanache(port, keys, blockTime ? { blockTime } : {});
  const ws = keys.map((k) => new ethers.Wallet(k, provider));
  const admin = ws[0];
  const H = ws.slice(1, 1 + hotels);
  const HA = ws.slice(1 + hotels, 1 + hotels + healths);
  const T = ws.slice(1 + hotels + healths, 1 + hotels + healths + tourists);
  const spare = ws.slice(1 + hotels + healths + tourists);
  const sys = await deploySystem(admin);
  const reg = sys.registry.contract;
  const crm = sys.crm.contract;
  const S = new Map();
  const sender = (w) => S.get(w.address) || S.set(w.address, new Sender(w)).get(w.address);
  let last;
  for (const w of H) last = await sender(admin).fire(reg, "registerParticipant", [w.address, 2, "H"]);
  for (const w of HA) last = await sender(admin).fire(reg, "registerParticipant", [w.address, 3, "HA"]);
  for (const w of T) last = await sender(admin).fire(reg, "registerParticipant", [w.address, 1, ""]);
  await last.wait();
  for (const w of T) last = await sender(w).fire(crm, "setConsent", [true]);
  await last.wait();
  const dataDir = tmp("pctf-ext-");
  const pepper = crypto.randomBytes(32);
  const kek = crypto.randomBytes(32);
  const storage = new StorageService({ dataDir, mode: "local" });
  const replica = withIpfs ? new StorageService({ dataDir: path.join(dataDir, "replica"), mode: "ipfs" }) : null;
  const keystore = new KeyStore({ dataDir, kek });
  const audit = new AuditLog({ dataDir });
  const W = buildWorkload();
  const recs = [];
  for (let i = 0; i < N; i++) {
    const st = W.stays[i];
    const hotel = H[st.venueIdx % hotels];
    const owner = T[st.touristIdx % tourists];
    const { ciphertext, dek } = encryptPayload(st.payload);
    const put = await storage.put(ciphertext);
    if (replica) await replica.put(ciphertext);
    const sp = subjectPseudonym(pepper, st.tourist, epochOf(st.tStart));
    const vp = venuePseudonym(pepper, st.venue);
    last = await sender(hotel).fire(crm, "createVenueRecord", [sp, vp, put.digest, st.tStart, st.tEnd, 0, put.scheme]);
    keystore.put(put.digest, dek, { owner: owner.address }, false);
    recs.push({ id: i + 1, st, hotel, owner, digest: put.digest, ciphertext, sp, vp, tx: last });
  }
  await last.wait();
  keystore.flush();
  const krsOpts = { registry: reg.connect(provider), crm: crm.connect(provider), keystore, storage, audit, pepper, nonceLog: nonceLog ? path.join(dataDir, "nonces.log") : null };
  const krs = new KeyReleaseService(krsOpts);
  return { server, provider, ws, admin, H, HA, T, spare, sys, reg, crm, sender, dataDir, pepper, kek, storage, replica, keystore, audit, recs, krs, krsOpts, W };
}

// ===================================================================== E14 baselines
async function baselines() {
  log("E14 baselines");
  const N = 500;
  const F = await pctfFixture({ port: 18710, N, hotels: 10, healths: 16, tourists: 50 });
  const { provider, admin, H, HA, reg, crm, sender, recs, krs } = F;
  const out = { N, hotels: 10 };
  // ---- PCTF write gas
  const pctfGas = [];
  for (const r of recs) pctfGas.push((await provider.getTransactionReceipt(r.tx.hash)).gasUsed.toNumber());
  // ---- ACL baseline deployment on the same chain
  const acl = (await deploy(admin, "AclRecordManager")).contract;
  sender(admin).nonce = null; // deploy() used the wallet directly
  for (const h of H) await sender(admin).exec(acl, "setWriter", [h.address, true]);
  const aclGas = [];
  const aclIdsBy = new Map();
  for (const r of recs) {
    const x = await sender(r.hotel).exec(acl, "createRecord", [r.sp, r.vp, r.digest, r.st.tStart, r.st.tEnd]);
    aclGas.push(x.gas);
    (aclIdsBy.get(r.hotel.address) || aclIdsBy.set(r.hotel.address, []).get(r.hotel.address)).push(r.id);
  }
  /** Grants or revokes one reader on the first n records, in owner batches of 100. */
  async function aclSetReader(reader, allowed, n = N) {
    let gas = 0;
    let txs = 0;
    for (const h of H) {
      const ids = aclIdsBy.get(h.address).filter((id) => id <= n);
      for (let b = 0; b < ids.length; b += 100) {
        const x = await sender(h).exec(acl, "setReader", [ids.slice(b, b + 100), reader, allowed], 8_000_000);
        gas += x.gas;
        txs++;
      }
    }
    return { gas, txs };
  }
  // initial governance: 15 health authorities may read every record
  let aclInitGas = 0;
  let aclInitTx = 0;
  for (const ha of HA.slice(0, 15)) {
    const g = await aclSetReader(ha.address, true);
    aclInitGas += g.gas;
    aclInitTx += g.txs;
  }
  // PCTF registration of the same 15 authorities was done in the fixture; measure one registration here
  const newHA = F.spare[0];
  const pctfOnboard = await sender(admin).exec(reg, "registerParticipant", [newHA.address, 3, "HA-new"]);
  const aclOnboard100 = await aclSetReader(F.spare[1].address, true, 100);
  const aclOnboard500 = await aclSetReader(HA[15].address, true, N);
  const pctfRevoke = await sender(admin).exec(reg, "revokeParticipant", [newHA.address]);
  const aclRevoke500 = await aclSetReader(HA[15].address, false, N);
  const pctfPolicy = await sender(admin).exec(crm, "setPolicy", [3, 1, 0, false]);
  let aclPolicyGas = 0;
  let aclPolicyTx = 0;
  for (const ha of HA.slice(0, 15)) {
    const g = await aclSetReader(ha.address, false);
    aclPolicyGas += g.gas;
    aclPolicyTx += g.txs;
  }
  await sender(admin).exec(crm, "setPolicy", [3, 1, 0, true]);
  for (const ha of HA.slice(0, 15)) await aclSetReader(ha.address, true);
  out.writeGas = { pctf: stats(pctfGas), acl: stats(aclGas) };
  out.governance = {
    initial15Readers: { pctfTx: 15, pctfGas: null, aclTx: aclInitTx, aclGas: aclInitGas },
    onboardReader: { pctfTx: 1, pctfGas: pctfOnboard.gas, acl100Tx: aclOnboard100.txs, acl100Gas: aclOnboard100.gas, acl500Tx: aclOnboard500.txs, acl500Gas: aclOnboard500.gas },
    revokeReader: { pctfTx: 1, pctfGas: pctfRevoke.gas, acl500Tx: aclRevoke500.txs, acl500Gas: aclRevoke500.gas },
    policyChange: { pctfTx: 1, pctfGas: pctfPolicy.gas, acl500Tx: aclPolicyTx, acl500Gas: aclPolicyGas },
  };
  log("E14 governance", JSON.stringify(out.governance));

  // ---- release latency: PCTF, ACL (same KRS logic, ACL check instead of role + policy), centralised
  const aclRead = acl.connect(provider);
  const aclAudit = new AuditLog({ dataDir: tmp("pctf-acl-") });
  async function aclRelease(auth) {
    const who = krs.authenticate({ ...auth, action: "release" });
    const blockTag = await provider.getBlockNumber();
    if (!(await aclRead.canRead(auth.target, who, { blockTag }))) throw new Error("denied: acl");
    const rec = await aclRead.getRecord(auth.target, { from: who, blockTag });
    const k = F.keystore.get(rec.contentDigest);
    if (!k) throw new Error("denied: key destroyed");
    const ct = await F.storage.get(rec.contentDigest, 0);
    const { decryptPayload } = require("../../backend/src/utils/crypto");
    decryptPayload(ct, k.dek);
    aclAudit.append({ decision: "GRANT", who, recordId: String(auth.target), block: blockTag });
  }
  const central = new CentralRecordService({ dataDir: tmp("pctf-central-"), keystore: F.keystore, storage: F.storage, pepper: F.pepper });
  central.register(null, admin.address, 0);
  for (const h of H) central.register(admin.address, h.address, 2);
  for (const ha of HA) central.register(admin.address, ha.address, 3);
  for (const t of F.T) central.setConsent(t.address, true);
  const centralWrite = [];
  for (const r of recs) {
    const t0 = now();
    central.createVenueRecord(r.hotel.address, { subjectHash: r.sp, venueHash: r.vp, contentDigest: r.digest, tStart: r.st.tStart, tEnd: r.st.tEnd });
    centralWrite.push(ms(t0));
  }
  const pctfWriteLat = [];
  for (const r of recs.slice(0, 200)) {
    const x = await sender(r.hotel).exec(crm, "createVenueRecord", [r.sp, r.vp, r.digest, r.st.tStart, r.st.tEnd, 0, 0]);
    pctfWriteLat.push(x.latency);
  }
  const rel = { pctf: [], acl: [], central: [] };
  const rows = [];
  for (let k = 0; k < 300; k++) {
    const r = recs[(k * 7) % N];
    const ha = HA[k % 15];
    let t0 = now();
    await krs.release(await sign(ha, "release", r.id));
    rel.pctf.push(ms(t0));
    const a2 = await sign(ha, "release", r.id);
    t0 = now();
    await aclRelease(a2);
    rel.acl.push(ms(t0));
    const a3 = await sign(ha, "release", r.id);
    t0 = now();
    await central.krs.release(a3);
    rel.central.push(ms(t0));
    rows.push({ k, recordId: r.id, pctfMs: rel.pctf[k].toFixed(3), aclMs: rel.acl[k].toFixed(3), centralMs: rel.central[k].toFixed(3) });
  }
  writeCsv("e14_release_latency.csv", rows);
  out.releaseMs = { pctf: stats(rel.pctf), acl: stats(rel.acl), central: stats(rel.central) };
  out.writeLatencyMs = { pctfInstamine: stats(pctfWriteLat), central: stats(centralWrite) };

  // ---- revocation in the centralised baseline: effective for the next request
  const victim = HA[3];
  const before = await tryRelease(central.krs, await sign(victim, "release", 5));
  central.revoke(admin.address, victim.address);
  const after = await tryRelease(central.krs, await sign(victim, "release", 5));
  out.centralRevocation = { before, after };

  // ---- auditability: operator rewrite of the centralised signed log
  const linesBefore = central.audit.lines();
  const grantIdx = linesBefore.findIndex((l) => l.decision === "GRANT");
  const v0 = SignedAuditLog.verify(linesBefore, central.publicKey);
  central.audit.rewriteWithout(grantIdx);
  const v1 = SignedAuditLog.verify(central.audit.lines(), central.publicKey);
  // ---- PCTF: anchor the audit head on-chain, then try the same rewrite
  const anchor = (await deploy(admin, "AuditAnchor", [admin.address])).contract;
  sender(admin).nonce = null;
  const auditLines = fs.readFileSync(path.join(F.dataDir, "audit.log"), "utf8").trim().split("\n");
  const anc = await sender(admin).exec(anchor, "anchor", [F.audit.head, auditLines.length]);
  const gi = auditLines.findIndex((l) => JSON.parse(l).decision === "GRANT");
  let prev = "0x" + "0".repeat(64);
  const rewritten = auditLines.filter((_, i) => i !== gi).map((l) => {
    const { hash, ...body } = JSON.parse(l);
    const b = { ...body, prev };
    prev = "0x" + crypto.createHash("sha256").update(JSON.stringify(b)).digest("hex");
    return { ...b, hash: prev };
  });
  const onchainHead = await anchor.head();
  const onchainCount = (await anchor.entries()).toNumber();
  out.auditability = {
    central: { entries: linesBefore.length, verifiesBeforeRewrite: v0.ok, droppedEntry: grantIdx, verifiesAfterRewrite: v1.ok, detected: !v1.ok },
    pctf: { entries: auditLines.length, anchorGas: anc.gas, rewrittenHeadMatchesAnchor: prev === onchainHead, countMatchesAnchor: rewritten.length === onchainCount, detected: prev !== onchainHead || rewritten.length !== onchainCount },
  };
  log("E14 audit", JSON.stringify(out.auditability));
  log("E14 release", JSON.stringify(out.releaseMs));
  writeCsv("e14_governance.csv", [
    { operation: "write one record (gas)", pctf: out.writeGas.pctf.mean, acl: out.writeGas.acl.mean },
    { operation: "grant 15 readers on 500 records (gas)", pctf: "15 registrations", acl: aclInitGas },
    { operation: "onboard one reader, 100 records (gas)", pctf: pctfOnboard.gas, acl: aclOnboard100.gas },
    { operation: "onboard one reader, 500 records (gas)", pctf: pctfOnboard.gas, acl: aclOnboard500.gas },
    { operation: "revoke one reader, 500 records (gas)", pctf: pctfRevoke.gas, acl: aclRevoke500.gas },
    { operation: "remove venue read from all authorities, 500 records (gas)", pctf: pctfPolicy.gas, acl: aclPolicyGas },
  ]);
  mergeSummary("E14", out);
  await F.server.close();
}

// ===================================================================== E16 scale and density
async function scale() {
  log("E16 scale and density");
  const configs = [
    { tourists: 950, venues: 30, thetas: [0, 900, 3600] },
    { tourists: 1900, venues: 30 },
    { tourists: 3800, venues: 30 },
    { tourists: 1900, venues: 60 },
    { tourists: 1900, venues: 10 },
  ];
  const rows = [];
  let port = 18720;
  for (const c of configs) {
    const W = buildWorkload({ tourists: c.tourists, venues: c.venues });
    const keys = keysN(c.venues + 2);
    const { server, provider } = await startGanache(port++, keys);
    const ws = keys.map((k) => new ethers.Wallet(k, provider));
    const admin = ws[0];
    const ha = ws[1];
    const hotels = ws.slice(2);
    const sys = await deploySystem(admin);
    const reg = sys.registry.contract;
    const crm = sys.crm.contract;
    const S = new Map();
    const sender = (w) => S.get(w.address) || S.set(w.address, new Sender(w)).get(w.address);
    let last = await sender(admin).fire(reg, "registerParticipant", [ha.address, 3, "HA"]);
    for (const h of hotels) last = await sender(admin).fire(reg, "registerParticipant", [h.address, 2, "H"]);
    await last.wait();
    const pepper = crypto.randomBytes(32);
    const t0 = now();
    const txs = [];
    for (const st of W.stays) {
      st.sp = subjectPseudonym(pepper, st.tourist, epochOf(st.tStart));
      st.vp = venuePseudonym(pepper, st.venue);
      const digest = sha256Hex(Buffer.from(JSON.stringify(st.payload)));
      txs.push(await sender(hotels[st.venueIdx]).fire(crm, "createVenueRecord", [st.sp, st.vp, digest, st.tStart, st.tEnd, 0, 0]));
    }
    await txs[txs.length - 1].wait();
    const loadSec = ms(t0) / 1000;
    const gas = [];
    for (let k = 0; k < 100; k++) gas.push((await provider.getTransactionReceipt(txs[Math.floor((k * txs.length) / 100)].hash)).gasUsed.toNumber());
    // diagnoses: 15 tourists with a stay in the 10-day window (fixed seed)
    const R = rng(4242);
    const tD = 1772409600 + 14 * 86400;
    const tFrom = tD - 10 * 86400;
    const staysBy = new Map();
    for (const st of W.stays) (staysBy.get(st.tourist) || staysBy.set(st.tourist, []).get(st.tourist)).push(st);
    const cand = W.tourists.filter((t) => staysBy.get(t).some((s) => s.tEnd >= tFrom));
    const diag = [];
    while (diag.length < 15) {
      const t = cand[Math.floor(R() * cand.length)];
      if (!diag.includes(t)) diag.push(t);
    }
    // anonymity sets: subjects per (venue, check-in epoch)
    const cells = new Map();
    for (const st of W.stays) {
      const key = `${st.venueIdx}:${epochOf(st.tStart)}`;
      (cells.get(key) || cells.set(key, new Set()).get(key)).add(st.tourist);
    }
    const kOf = W.stays.map((st) => cells.get(`${st.venueIdx}:${epochOf(st.tStart)}`).size);
    for (const theta of c.thetas || [0]) {
      let tp = 0;
      let fp = 0;
      let fn = 0;
      let gtTotal = 0;
      const matchMs = [];
      const scanned = [];
      for (const t of diag) {
        const gt = new Set();
        for (const s of staysBy.get(t).filter((s) => s.tEnd >= tFrom && s.tStart <= tD)) {
          const vs = Math.max(s.tStart, tFrom);
          const ve = Math.min(s.tEnd, tD);
          for (const o of W.stays) if (o.tourist !== t && o.venue === s.venue && signedOverlap(o.tStart, o.tEnd, vs, ve) >= theta) gt.add(o.sp.toLowerCase());
        }
        const ps = subjectPseudonymsInWindow(pepper, t, tFrom - 3 * 86400, tD).map((x) => x.pseudonym);
        const m0 = now();
        const m = await matchExposures(crm.connect(ha), ps, tFrom, tD, theta);
        matchMs.push(ms(m0));
        scanned.push(m.scanned);
        const found = new Set(m.exposed);
        for (const x of found) gt.has(x) ? tp++ : fp++;
        fn += [...gt].filter((x) => !found.has(x)).length;
        gtTotal += gt.size;
      }
      const row = {
        tourists: c.tourists, venues: c.venues, records: W.stays.length, recordsPerVenue: +(W.stays.length / c.venues).toFixed(1),
        thetaSec: theta, loadSec: +loadSec.toFixed(1), gasMean: stats(gas).mean, gasMax: stats(gas).max,
        groundTruth: gtTotal, truePositives: tp, falsePositives: fp, falseNegatives: fn,
        precision: +(tp / Math.max(1, tp + fp)).toFixed(4), recall: +(tp / Math.max(1, tp + fn)).toFixed(4),
        matchMsMean: stats(matchMs).mean, matchMsP95: stats(matchMs).p95, scannedMean: stats(scanned).mean,
        kMedian: stats(kOf).p50, kOneShare: +(kOf.filter((k) => k === 1).length / kOf.length).toFixed(4),
      };
      rows.push(row);
      log("E16", JSON.stringify(row));
    }
    await server.close();
  }
  writeCsv("e16_scale_density.csv", rows);
  mergeSummary("E16", rows);
}

// ===================================================================== E17 concurrency and replay
async function concurrency() {
  log("E17 concurrency");
  const F = await pctfFixture({ port: 18740, N: 200, hotels: 10, healths: 8, tourists: 40, nonceLog: true });
  const { HA, recs, krs } = F;
  const levels = [1, 4, 16, 64, 256];
  const rows = [];
  const out = { levels: {} };
  for (const c of levels) {
    const total = 512;
    const reqs = [];
    for (let k = 0; k < total; k++) reqs.push(await sign(HA[k % HA.length], "release", recs[(k * 13) % recs.length].id));
    const lat = [];
    let granted = 0;
    let idx = 0;
    const t0 = now();
    async function worker() {
      while (idx < total) {
        const a = reqs[idx++];
        const t1 = now();
        const r = await tryRelease(krs, a);
        lat.push(ms(t1));
        if (r === "GRANT") granted++;
      }
    }
    await Promise.all(Array.from({ length: c }, worker));
    const wall = ms(t0) / 1000;
    const s = stats(lat);
    out.levels[c] = { requests: total, granted, throughputPerSec: +(total / wall).toFixed(1), latencyMs: s };
    rows.push({ concurrency: c, requests: total, granted, throughputPerSec: +(total / wall).toFixed(1), p50Ms: s.p50, p95Ms: s.p95, maxMs: s.max });
    log("E17", JSON.stringify(rows[rows.length - 1]));
  }
  writeCsv("e17_concurrency.csv", rows);
  // replay race: 32 concurrent copies of one signed challenge
  let trials = 0;
  const grantsPerTrial = [];
  for (let k = 0; k < 100; k++) {
    const a = await sign(HA[k % HA.length], "release", recs[k].id);
    const res = await Promise.all(Array.from({ length: 32 }, () => tryRelease(krs, { ...a })));
    grantsPerTrial.push(res.filter((r) => r === "GRANT").length);
    trials++;
  }
  out.replayRace = { trials, copies: 32, grantsPerTrial: stats(grantsPerTrial), trialsWithExactlyOneGrant: grantsPerTrial.filter((g) => g === 1).length };
  // replay across a restart: with the nonce log and without it
  let deniedWithLog = 0;
  let grantedWithoutLog = 0;
  for (let k = 0; k < 50; k++) {
    const a = await sign(HA[k % HA.length], "release", recs[100 + k].id);
    const first = await tryRelease(krs, { ...a });
    if (first !== "GRANT") continue;
    const restarted = new KeyReleaseService(F.krsOpts); // same nonce log
    if ((await tryRelease(restarted, { ...a })) !== "GRANT") deniedWithLog++;
    const restartedNoLog = new KeyReleaseService({ ...F.krsOpts, nonceLog: null });
    if ((await tryRelease(restartedNoLog, { ...a })) === "GRANT") grantedWithoutLog++;
  }
  out.replayAcrossRestart = { trials: 50, deniedWithNonceLog: deniedWithLog, grantedWithoutNonceLog: grantedWithoutLog };
  out.revocationRace = await revocationRace(F);
  log("E17", JSON.stringify(out.replayRace), JSON.stringify(out.replayAcrossRestart), JSON.stringify(out.revocationRace));
  mergeSummary("E17", out);
  await F.server.close();
}


/** Releases issued every 20 ms for 3 s by one health authority while it is revoked (2 s blocks). */
async function revocationRace(F) {
  const { HA, recs, krs, dataDir } = F;
  const victim = HA[0];
  const auditFile = path.join(dataDir, "audit.log");
  const startLine = fs.readFileSync(auditFile, "utf8").trim().split("\n").length;
  const pending = [];
  const t0 = Date.now();
  let revokeBlock = null;
  const revokeP = (async () => {
    await sleep(800);
    const x = await new Sender(F.admin).exec(F.reg, "revokeParticipant", [victim.address]);
    revokeBlock = x.rc.blockNumber;
  })();
  for (let k = 0; Date.now() - t0 < 6000; k++) {
    const a = await sign(victim, "release", recs[k % recs.length].id);
    pending.push(tryRelease(krs, a));
    await sleep(20);
  }
  const results = await Promise.all(pending);
  await revokeP;
  const entries = fs.readFileSync(auditFile, "utf8").trim().split("\n").slice(startLine).map((l) => JSON.parse(l)).filter((e) => e.who && e.who.toLowerCase() === victim.address.toLowerCase());
  const grants = entries.filter((e) => e.decision === "GRANT");
  const inactive = entries.filter((e) => e.reason === "not an active participant");
  return {
    requests: results.length, granted: results.filter((r) => r === "GRANT").length, deniedInactive: results.filter((r) => r === "not an active participant").length,
    revokeBlock, maxGrantBlock: Math.max(...grants.map((e) => e.block)), minDenyBlock: Math.min(...inactive.map((e) => e.block)),
    decisionsConsistentWithDecisionBlock: grants.every((e) => e.block < revokeBlock) && inactive.every((e) => e.block >= revokeBlock),
  };
}

async function race() {
  const F = await pctfFixture({ port: 18745, N: 50, hotels: 5, healths: 2, tourists: 10, blockTime: 2 });
  const r = await revocationRace(F);
  log("E17 race", JSON.stringify(r));
  const f = path.join(__dirname, "..", "..", "results", "summary.json");
  const S = JSON.parse(fs.readFileSync(f, "utf8"));
  S.E17 = { ...(S.E17 || {}), revocationRace: r };
  fs.writeFileSync(f, JSON.stringify(S, null, 2));
  await F.server.close();
}

// ===================================================================== E18 failures
/** TCP relay used to cut and restore the KRS connection to the chain. */
function relay(listenPort, targetPort) {
  const socks = new Set();
  let srv = null;
  const up = () => new Promise((res) => {
    srv = net.createServer((c) => {
      const u = net.connect(targetPort, "127.0.0.1");
      socks.add(c);
      socks.add(u);
      c.pipe(u).pipe(c);
      const done = () => { c.destroy(); u.destroy(); socks.delete(c); socks.delete(u); };
      c.on("error", done); u.on("error", done); c.on("close", done); u.on("close", done);
    });
    srv.listen(listenPort, "127.0.0.1", res);
  });
  const down = () => new Promise((res) => {
    for (const s of socks) s.destroy();
    socks.clear();
    srv.close(() => res());
  });
  return { up, down };
}

async function failures() {
  log("E18 failures");
  const F = await pctfFixture({ port: 18750, N: 120, hotels: 6, healths: 4, tourists: 30, withIpfs: true, nonceLog: true });
  const { HA, recs, krs, storage, replica, dataDir } = F;
  const ha = HA[0];
  const out = {};
  const objPath = (d) => path.join(dataDir, "objects", d.slice(2) + ".bin");
  const restore = async (r) => fs.writeFileSync(objPath(r.digest), await replica.get(r.digest, 1));
  // (a) missing objects
  const miss = recs.slice(0, 20);
  for (const r of miss) fs.unlinkSync(objPath(r.digest));
  const missRes = [];
  for (const r of miss) missRes.push(await tryRelease(krs, await sign(ha, "release", r.id)));
  for (const r of miss) await restore(r);
  const missAfter = [];
  for (const r of miss) missAfter.push(await tryRelease(krs, await sign(ha, "release", r.id)));
  out.missingObject = { objects: miss.length, denied: missRes.filter((x) => x === "object unavailable").length, restoredFromReplica: missAfter.filter((x) => x === "GRANT").length };
  // (b) corrupted objects (one flipped bit), then restore
  const cor = recs.slice(20, 40);
  for (const r of cor) {
    const b = fs.readFileSync(objPath(r.digest));
    b[b.length >> 1] ^= 1;
    fs.writeFileSync(objPath(r.digest), b);
  }
  const corRes = [];
  for (const r of cor) corRes.push(await tryRelease(krs, await sign(ha, "release", r.id)));
  // a replica that is also corrupted is rejected by the same digest check
  const badReplica = Buffer.from(fs.readFileSync(objPath(cor[0].digest)));
  const replicaAccepted = sha256Hex(badReplica) === cor[0].digest.toLowerCase();
  for (const r of cor) await restore(r);
  const corAfter = [];
  for (const r of cor) corAfter.push(await tryRelease(krs, await sign(ha, "release", r.id)));
  out.corruptedObject = { objects: cor.length, denied: corRes.filter((x) => x === "integrity check failed").length, corruptedReplicaAccepted: replicaAccepted, restoredFromReplica: corAfter.filter((x) => x === "GRANT").length };
  // (c) whole local store lost, recovered from the IPFS replica
  fs.rmSync(path.join(dataDir, "objects"), { recursive: true });
  fs.mkdirSync(path.join(dataDir, "objects"));
  const lost = [];
  for (const r of recs.slice(40, 60)) lost.push(await tryRelease(krs, await sign(ha, "release", r.id)));
  const t0 = now();
  for (const r of recs) await restore(r);
  const restoreMs = ms(t0);
  const back = [];
  for (const r of recs.slice(40, 60)) back.push(await tryRelease(krs, await sign(ha, "release", r.id)));
  out.storeLost = { objects: recs.length, deniedWhileLost: lost.filter((x) => x === "object unavailable").length, sampled: lost.length, restoreAllMs: +restoreMs.toFixed(1), grantedAfterRestore: back.filter((x) => x === "GRANT").length };
  // (d) chain unavailable: KRS reaches the node through a relay that is cut and restored
  const rl = relay(18759, 18750);
  await rl.up();
  const p2 = new ethers.providers.StaticJsonRpcProvider("http://127.0.0.1:18759", { chainId: 1337, name: "relay" });
  const krsR = new KeyReleaseService({ ...F.krsOpts, registry: F.reg.connect(p2), crm: F.crm.connect(p2), nonceLog: null });
  const okBefore = await tryRelease(krsR, await sign(ha, "release", recs[70].id));
  await rl.down();
  const during = [];
  const denyMs = [];
  for (const r of recs.slice(70, 90)) {
    const a = await sign(ha, "release", r.id);
    const t1 = now();
    during.push(await tryRelease(krsR, a));
    denyMs.push(ms(t1));
  }
  await rl.up();
  const tUp = now();
  let firstGrantMs = null;
  const afterReasons = [];
  for (let k = 0; k < 100 && firstGrantMs === null; k++) {
    const r = await tryRelease(krsR, await sign(ha, "release", recs[91].id));
    if (r === "GRANT") firstGrantMs = ms(tUp);
    else afterReasons.push(r);
    if (firstGrantMs === null) await sleep(50);
  }
  await rl.down();
  out.chainUnavailable = { before: okBefore, requests: during.length, granted: during.filter((x) => x === "GRANT").length, deniedChainUnavailable: during.filter((x) => x === "chain unavailable").length, denyLatencyMs: stats(denyMs), firstGrantAfterRecoveryMs: firstGrantMs && +firstGrantMs.toFixed(1), deniedAfterRecovery: afterReasons.length, reasonsAfterRecovery: [...new Set(afterReasons)] };
  // (e) KRS restart: keys, audit chain and nonce log survive
  const auth = await sign(ha, "release", recs[95].id);
  const g1 = await tryRelease(krs, { ...auth });
  const ks2 = new KeyStore({ dataDir, kek: F.kek });
  const audit2 = new AuditLog({ dataDir });
  const krs2 = new KeyReleaseService({ ...F.krsOpts, keystore: ks2, audit: audit2 });
  const replay = await tryRelease(krs2, { ...auth });
  const fresh = [];
  for (const r of recs.slice(96, 116)) fresh.push(await tryRelease(krs2, await sign(ha, "release", r.id)));
  out.krsRestart = { grantBefore: g1, replayAfterRestart: replay, freshGrantsAfterRestart: fresh.filter((x) => x === "GRANT").length, of: fresh.length, keysReloaded: Object.keys(ks2.db.keys).length, auditChain: audit2.verify() };
  // (f) a key-store backup taken before erasure brings shredded records back
  const snap = fs.readFileSync(path.join(dataDir, "keystore.json"));
  const tourist = recs[0].owner;
  await new Sender(tourist).exec(F.crm, "setConsent", [false]);
  const shredded = krs2.onConsentWithdrawn(tourist.address);
  const own = recs.filter((r) => r.owner.address === tourist.address);
  const selfAfter = [];
  for (const r of own) selfAfter.push(await tryRelease(krs2, await sign(tourist, "release", r.id)));
  fs.writeFileSync(path.join(dataDir, "keystore.json"), snap);
  const krs3 = new KeyReleaseService({ ...F.krsOpts, keystore: new KeyStore({ dataDir, kek: F.kek }), audit: new AuditLog({ dataDir }) });
  const selfRestored = [];
  for (const r of own) selfRestored.push(await tryRelease(krs3, await sign(tourist, "release", r.id)));
  out.backupAfterErasure = { shredded, ownRecords: own.length, deniedAfterShred: selfAfter.filter((x) => x !== "GRANT").length, releasableAfterSnapshotRestore: selfRestored.filter((x) => x === "GRANT").length };
  log("E18", JSON.stringify(out));
  await replica.close();
  mergeSummary("E18", out);
  await F.server.close();
}

// ===================================================================== E20 metadata linkage
/**
 * Itinerary workload for the linkage attack. 30 venues sit in 6 towns on a ring (5 per town).
 * Each tourist makes 1 to 4 consecutive stays; each next stay is in a neighbouring town. The
 * next check-in follows the previous check-out after the public road travel time between the
 * two towns (1.5 to 4 h, fixed per pair) plus a personal stop of 0 to 120 minutes. Venue identities are treated as public
 * (the venue pseudonym is static and the creating hotel address is a registered business).
 * An observer of public chain state sees per record: venue, tStart, tEnd and a subject
 * pseudonym that changes every day; consecutive stays start on different days, so they never
 * share a pseudonym.
 */
const TOWNS = 6;
const townOf = (v) => Math.floor(v / 5);
const adjacent = (a, b) => (a - b + TOWNS) % TOWNS === 1 || (b - a + TOWNS) % TOWNS === 1;
const travelSec = (a, b) => (90 + 30 * ((Math.min(a, b) * 7 + Math.max(a, b) * 3) % 6)) * 60;

function itineraries({ seed = 777, tourists = 950, days = 14, T0 = 1772409600 }) {
  const R = rng(seed + tourists);
  const ri = (lo, hi) => lo + Math.floor(R() * (hi - lo + 1));
  const recs = [];
  const nextOf = new Map();
  for (let t = 0; t < tourists; t++) {
    const legs = ri(1, 4);
    let town = ri(0, TOWNS - 1);
    const dir = R() < 0.5 ? 1 : TOWNS - 1;
    let day = ri(0, days - 2);
    let tStart = T0 + day * 86400 + ri(14, 22) * 3600 + ri(0, 59) * 60;
    let prevId = null;
    for (let k = 0; k < legs; k++) {
      const v = town * 5 + ri(0, 4);
      const nights = ri(1, 3);
      const tEnd = T0 + (day + nights) * 86400 + ri(8, 11) * 3600 + ri(0, 59) * 60;
      const id = recs.length;
      recs.push({ id, tourist: t, venue: v, tStart, tEnd });
      if (prevId !== null) nextOf.set(prevId, id);
      prevId = id;
      const nt = (town + dir) % TOWNS;
      tStart = tEnd + travelSec(town, nt) + ri(0, 120) * 60;
      town = nt;
      day = Math.floor((tStart - T0) / 86400);
    }
  }
  return { recs, nextOf };
}

/**
 * Targeted attack. The observer knows one record A of a target (for example a check-in seen in
 * person) and wants the target's next stay. Plausible successors are records in a neighbouring
 * town whose published check-in lies in [check-out(A) + travel, check-out(A) + travel + 2 h].
 * With coarse times (granularity g) the observer only sees floor(t / g) * g and widens the
 * window by g on each side. The true successor is always plausible, so a guess among the
 * plausible set C succeeds with probability 1 / |C|; following a whole itinerary from its first
 * record succeeds with the product of these probabilities.
 */
function plausibleSuccessors(recs, { gran = 1 } = {}) {
  const q = (x) => Math.floor(x / gran) * gran;
  const starts = recs.map((r) => ({ id: r.id, venue: r.venue, t: q(r.tStart) })).sort((a, b) => a.t - b.t);
  const out = new Map();
  for (const r of recs) {
    const e = q(r.tEnd);
    let lo = 0;
    let hi = starts.length;
    const from = e + 90 * 60 - gran;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (starts[m].t < from) lo = m + 1;
      else hi = m;
    }
    const set = [];
    const ta = townOf(r.venue);
    for (let i = lo; i < starts.length && starts[i].t <= e + 6 * 3600 + gran; i++) {
      const tb = townOf(starts[i].venue);
      if (!adjacent(ta, tb)) continue;
      const gap = starts[i].t - e;
      const tr = travelSec(ta, tb);
      if (gap >= tr - gran && gap <= tr + 7200 + gran) set.push(starts[i].id);
    }
    out.set(r.id, set);
  }
  return out;
}

async function linkage() {
  log("E20 metadata linkage");
  const rows = [];
  for (const tourists of [95, 380, 950, 3800]) {
    const { recs, nextOf } = itineraries({ tourists });
    const byT = new Map();
    for (const r of recs) (byT.get(r.tourist) || byT.set(r.tourist, []).get(r.tourist)).push(r.id);
    for (const gran of [1, 3600, 6 * 3600, 86400]) {
      const C = plausibleSuccessors(recs, { gran });
      const sizes = [];
      let covered = 0;
      for (const [a, b] of nextOf) {
        const c = C.get(a);
        if (c.includes(b)) covered++;
        sizes.push(c.length);
      }
      const itin = [];
      for (const ids of byT.values()) {
        if (ids.length < 2) continue;
        let p = 1;
        for (let i = 0; i + 1 < ids.length; i++) p *= 1 / C.get(ids[i]).length;
        itin.push(p);
      }
      const row = {
        tourists, records: recs.length, truePairs: nextOf.size, granularitySec: gran, trueSuccessorPlausible: +(covered / nextOf.size).toFixed(4),
        candidatesMedian: stats(sizes).p50, candidatesP95: stats(sizes).p95, uniqueCandidateShare: +(sizes.filter((c) => c === 1).length / sizes.length).toFixed(4),
        nextStaySuccess: +(sizes.reduce((x, c) => x + 1 / c, 0) / sizes.length).toFixed(4),
        multiStayTourists: itin.length, fullItinerarySuccess: +(itin.reduce((x, p) => x + p, 0) / itin.length).toFixed(4),
      };
      rows.push(row);
      log("E20", JSON.stringify(row));
    }
  }
  writeCsv("e20_linkage.csv", rows);
  mergeSummary("E20", rows);
}

(async () => {
  const which = process.argv[2] || "all";
  const parts = { baselines, scale, concurrency, race, failures, linkage };
  for (const [k, f] of Object.entries(parts)) if (which === "all" || which === k) await f();
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
