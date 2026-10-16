/**
 * PCTF evaluation runner. Reproduces all reported results.
 *   node scripts/experiments/run-all.js            (writes results/*.csv and results/summary.json)
 * Starts its own Ganache JSON-RPC server, deploys the contracts and runs:
 *   E1 registration and consent, E2 record creation (hybrid) with on-chain state tracing,
 *   E3 fully on-chain baseline (E4, throughput under block times, is scripts/experiments/throughput.js),
 *   E5 diagnosis, exposure matching and notification, E6 access-control matrix,
 *   E7 security tests (eth_call spoofing, replay, pseudonym reversal, linkability, tampering,
 *      consent withdrawal, retention), E8 key-release latency, E9 IPFS storage timing.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const ganache = require("ganache");
const { ethers } = require("ethers");
const { deploySystem, at } = require("../../backend/src/lib/contracts");
const { encryptPayload, sha256Hex } = require("../../backend/src/utils/crypto");
const { subjectPseudonym, venuePseudonym, epochOf, subjectPseudonymsInWindow } = require("../../backend/src/utils/pseudonym");
const { StorageService } = require("../../backend/src/services/storage.service");
const { KeyStore } = require("../../backend/src/services/keystore.service");
const { AuditLog } = require("../../backend/src/services/audit.service");
const { KeyReleaseService, challengeMessage } = require("../../backend/src/services/keyRelease.service");
const { matchExposures } = require("../../backend/src/services/exposure.service");

const ROOT = path.join(__dirname, "..", "..");
const OUT = path.join(ROOT, "results");
fs.mkdirSync(OUT, { recursive: true });

const CFG = {
  seed: 20260302,
  tourists: 950,
  hotels: 30,
  health: 15,
  tourism: 5,
  days: 14,
  T0: 1772409600, // 2026-03-02T00:00:00Z
  diagnosed: 15,
  windowDays: 10,
  maxStayDays: 3,
  ttlRecords: 50,
  ipfsSample: 300,
  releaseSample: 300,
  traceSample: 60,
  gasPriceGwei: 1,
};

// ---------------------------------------------------------------- helpers
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const R = rng(CFG.seed);
const ri = (lo, hi) => lo + Math.floor(R() * (hi - lo + 1));
const pick = (a) => a[Math.floor(R() * a.length)];
const ms = (t0) => Number(process.hrtime.bigint() - t0) / 1e6;
const now = () => process.hrtime.bigint();
function stats(arr) {
  const a = [...arr].sort((x, y) => x - y);
  const n = a.length;
  const mean = a.reduce((s, x) => s + x, 0) / n;
  const sd = Math.sqrt(a.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, n - 1));
  const q = (p) => a[Math.min(n - 1, Math.floor(p * (n - 1)))];
  return { n, mean: +mean.toFixed(2), sd: +sd.toFixed(2), min: a[0], p50: q(0.5), p95: q(0.95), max: a[n - 1] };
}
function writeCsv(name, rows) {
  if (!rows.length) return;
  const cols = Object.keys(rows[0]);
  const esc = (v) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  fs.writeFileSync(path.join(OUT, name), [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n"));
}
const summary = { config: CFG, generatedAt: new Date().toISOString(), node: process.version };

async function startChain(port, opts = {}) {
  const keys = opts.keys;
  const server = ganache.server({
    logging: { quiet: true },
    chain: { chainId: 1337, hardfork: "shanghai" },
    miner: opts.blockTime ? { blockGasLimit: 30_000_000, blockTime: opts.blockTime } : { blockGasLimit: 30_000_000, instamine: "eager" },
    wallet: { accounts: keys.map((k) => ({ secretKey: k, balance: "0x" + (10n ** 22n).toString(16) })) },
  });
  await new Promise((res, rej) => server.listen(port, (e) => (e ? rej(e) : res())));
  const provider = new ethers.providers.JsonRpcProvider(`http://127.0.0.1:${port}`);
  provider.pollingInterval = opts.blockTime ? 200 : 20;
  return { server, provider };
}

class Sender {
  constructor(wallet) {
    this.w = wallet;
    this.nonce = null;
  }
  async send(contract, method, args, gasLimit = 600000) {
    if (this.nonce === null) this.nonce = await this.w.getTransactionCount("pending");
    const data = contract.interface.encodeFunctionData(method, args);
    const tx = { to: contract.address, data, gasLimit, gasPrice: ethers.utils.parseUnits(String(CFG.gasPriceGwei), "gwei"), nonce: this.nonce++, chainId: 1337, type: 0 };
    return this.w.sendTransaction(tx);
  }
  async exec(contract, method, args, gasLimit) {
    const t0 = now();
    const tx = await this.send(contract, method, args, gasLimit);
    let rc;
    try {
      rc = await tx.wait();
    } catch (e) {
      rc = e.receipt;
    }
    return { rc, latency: ms(t0), ok: rc && rc.status === 1, gas: rc ? rc.gasUsed.toNumber() : null };
  }
}

async function sign(wallet, action, target) {
  const ts = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(12).toString("hex");
  const signature = await wallet.signMessage(challengeMessage(action, target, ts, nonce));
  return { target: String(target), ts, nonce, signature, claimedAddress: wallet.address };
}

async function newSlotsOf(provider, txHash, contractAddr) {
  const tr = await provider.send("debug_traceTransaction", [txHash, { disableMemory: true, disableStorage: true }]);
  const rc = await provider.getTransactionReceipt(txHash);
  const keys = new Set();
  for (const l of tr.structLogs) if (l.op === "SSTORE") keys.add(l.stack[l.stack.length - 1]);
  let fresh = 0;
  for (const k of keys) {
    const before = await provider.getStorageAt(contractAddr, "0x" + k.replace(/^0x/, "").padStart(64, "0"), rc.blockNumber - 1);
    if (before === "0x" || BigInt(before) === 0n) fresh++;
  }
  const logBytes = rc.logs.reduce((s, l) => s + (l.data.length - 2) / 2 + l.topics.length * 32, 0);
  return { slotsWritten: keys.size, newSlots: fresh, logBytes };
}

// ---------------------------------------------------------------- workload
function buildWorkload() {
  const tourists = Array.from({ length: CFG.tourists }, (_, i) => `T-${String(i + 1).padStart(4, "0")}`);
  const venues = Array.from({ length: CFG.hotels }, (_, i) => `V-${String(i + 1).padStart(2, "0")}`);
  const areas = ["lobby", "restaurant", "lift", "gym", "pool", "bar", "spa", "conference"];
  const stays = [];
  for (const [ti, t] of tourists.entries()) {
    const n = ri(1, 3);
    for (let k = 0; k < n; k++) {
      const v = ri(0, venues.length - 1);
      const day = ri(0, CFG.days - 2);
      const tStart = CFG.T0 + day * 86400 + ri(12, 22) * 3600 + ri(0, 59) * 60;
      const tEnd = tStart + ri(1, 3) * 86400 - ri(1, 6) * 3600;
      const log = Array.from({ length: ri(2, 12) }, () => ({ area: pick(areas), at: ri(tStart, tEnd) }));
      stays.push({
        tourist: t,
        touristIdx: ti,
        venue: venues[v],
        venueIdx: v,
        tStart,
        tEnd,
        payload: { guestRef: t, venue: venues[v], room: String(ri(100, 899)), partySize: ri(1, 4), checkIn: tStart, checkOut: tEnd, visitLog: log, note: "synthetic record for evaluation only" },
      });
    }
  }
  stays.sort((a, b) => a.tStart - b.tStart);
  return { tourists, venues, stays };
}

// ---------------------------------------------------------------- main
(async () => {
  const W = buildWorkload();
  const nPart = CFG.tourists + CFG.hotels + CFG.health + CFG.tourism;
  const keys = Array.from({ length: nPart + 12 }, () => ethers.Wallet.createRandom().privateKey);
  const { server, provider } = await startChain(18545, { keys });
  const wallets = keys.map((k) => new ethers.Wallet(k, provider));
  const admin = wallets[0];
  let wi = 1;
  const touristW = wallets.slice(wi, (wi += CFG.tourists));
  const hotelW = wallets.slice(wi, (wi += CFG.hotels));
  const healthW = wallets.slice(wi, (wi += CFG.health));
  const tourismW = wallets.slice(wi, (wi += CFG.tourism));
  const spare = wallets.slice(wi);

  const sys = await deploySystem(admin, { withBaseline: true });
  const reg = sys.registry.contract;
  const crm = sys.crm.contract;
  const base = sys.baseline.contract;
  summary.deployGas = { ParticipantRegistry: sys.registry.gasUsed, ContactRecordManager: sys.crm.gasUsed, FullOnChainRecordManager: sys.baseline.gasUsed };
  console.log("deployed", summary.deployGas);

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pctf-exp-"));
  const pepper = crypto.randomBytes(32);
  const kek = crypto.randomBytes(32);
  const storage = new StorageService({ dataDir, mode: "local" });
  const keystore = new KeyStore({ dataDir, kek });
  const audit = new AuditLog({ dataDir });
  const krs = new KeyReleaseService({ registry: reg.connect(provider), crm: crm.connect(provider), keystore, storage, audit, pepper });
  const S = new Map();
  const sender = (w) => {
    if (!S.has(w.address)) S.set(w.address, new Sender(w));
    return S.get(w.address);
  };

  // ------------------------------------------------ E1 registration + consent
  const regRows = [];
  const roleList = [
    ...touristW.map((w) => [w, 1, "Tourist"]),
    ...hotelW.map((w) => [w, 2, "Hotel"]),
    ...healthW.map((w) => [w, 3, "HealthAuthority"]),
    ...tourismW.map((w) => [w, 4, "TourismAuthority"]),
  ];
  // interleave roles so the run does not group by role
  roleList.sort(() => R() - 0.5);
  for (const [i, [w, role, name]] of roleList.entries()) {
    const r = await sender(admin).exec(reg, "registerParticipant", [w.address, role, role === 1 ? "" : `${name}-${i}`]);
    regRows.push({ index: i + 1, role: name, gasUsed: r.gas, latencyMs: r.latency.toFixed(2), status: r.ok ? "success" : "fail" });
  }
  writeCsv("e1_registration.csv", regRows);
  const consentRows = [];
  for (const [i, w] of touristW.entries()) {
    const r = await sender(w).exec(crm, "setConsent", [true]);
    consentRows.push({ index: i + 1, gasUsed: r.gas, latencyMs: r.latency.toFixed(2), status: r.ok ? "success" : "fail" });
    krs.enrolTourist(w.address, W.tourists[i]);
  }
  writeCsv("e1_consent.csv", consentRows);
  summary.E1 = {
    registrations: regRows.length,
    success: regRows.filter((r) => r.status === "success").length,
    gas: stats(regRows.map((r) => r.gasUsed)),
    latencyMs: stats(regRows.map((r) => +r.latencyMs)),
    byRole: Object.fromEntries(["Tourist", "Hotel", "HealthAuthority", "TourismAuthority"].map((n) => [n, { n: regRows.filter((r) => r.role === n).length, gas: stats(regRows.filter((r) => r.role === n).map((r) => r.gasUsed)).mean, latency: stats(regRows.filter((r) => r.role === n).map((r) => +r.latencyMs)).mean }])),
    consentGas: stats(consentRows.map((r) => r.gasUsed)),
  };
  console.log("E1", summary.E1.success, summary.E1.gas.mean);

  // ------------------------------------------------ E2 record creation (hybrid)
  const recRows = [];
  const recOf = []; // stay index -> record id
  const ttlSet = new Set(Array.from({ length: CFG.ttlRecords }, () => ri(0, W.stays.length - 1)));
  for (const [i, st] of W.stays.entries()) {
    const hotel = hotelW[st.venueIdx];
    const t0 = now();
    const { ciphertext, dek, plaintextBytes } = encryptPayload(st.payload);
    const tEnc = ms(t0);
    const t1 = now();
    const put = await storage.put(ciphertext);
    const tStore = ms(t1);
    const sp = subjectPseudonym(pepper, st.tourist, epochOf(st.tStart));
    const vp = venuePseudonym(pepper, st.venue);
    const ttl = ttlSet.has(i) ? 3 * 86400 : 0;
    const r = await sender(hotel).exec(crm, "createVenueRecord", [sp, vp, put.digest, st.tStart, st.tEnd, ttl, put.scheme]);
    const id = recRows.length + 1;
    keystore.put(put.digest, dek, { owner: touristW[st.touristIdx].address, expiresAt: ttl ? Math.floor(Date.now() / 1000) + ttl : 0 }, false);
    st.recordId = id;
    st.sp = sp;
    st.vp = vp;
    st.digest = put.digest;
    st.ciphertext = ciphertext;
    st.ttl = ttl;
    recOf.push(id);
    recRows.push({ recordId: id, hotel: st.venue, plaintextBytes, ciphertextBytes: ciphertext.length, encryptMs: tEnc.toFixed(3), storeMs: tStore.toFixed(3), txLatencyMs: r.latency.toFixed(2), gasUsed: r.gas, status: r.ok ? "success" : "fail", txHash: r.rc.transactionHash });
  }
  keystore.flush();
  // trace a sample for exact new on-chain state
  const traced = [];
  for (let k = 0; k < CFG.traceSample; k++) {
    const row = recRows[Math.floor((k * recRows.length) / CFG.traceSample)];
    const t = await newSlotsOf(provider, row.txHash, crm.address);
    traced.push({ recordId: row.recordId, gasUsed: row.gasUsed, ...t });
  }
  writeCsv("e2_record_creation.csv", recRows);
  writeCsv("e2_state_trace.csv", traced);
  const ctBytes = recRows.map((r) => r.ciphertextBytes);
  const newState = traced.map((t) => t.newSlots * 32);
  summary.E2 = {
    records: recRows.length,
    success: recRows.filter((r) => r.status === "success").length,
    gas: stats(recRows.map((r) => r.gasUsed)),
    txLatencyMs: stats(recRows.map((r) => +r.txLatencyMs)),
    encryptMs: stats(recRows.map((r) => +r.encryptMs)),
    storeMs: stats(recRows.map((r) => +r.storeMs)),
    plaintextBytes: stats(recRows.map((r) => r.plaintextBytes)),
    ciphertextBytes: stats(ctBytes),
    newOnChainStateBytes: stats(newState),
    newSlots: stats(traced.map((t) => t.newSlots)),
    logBytes: stats(traced.map((t) => t.logBytes)),
  };
  console.log("E2", summary.E2.success, summary.E2.gas.mean, summary.E2.ciphertextBytes.mean, summary.E2.newOnChainStateBytes.mean);

  // ------------------------------------------------ E3 fully on-chain baseline
  const baseRows = [];
  const hb = hotelW[0];
  for (const size of [256, 512, 1024, 2048, 4096]) {
    for (let k = 0; k < 20; k++) {
      const payload = crypto.randomBytes(size);
      const sp = ethers.utils.hexlify(crypto.randomBytes(32));
      const vp = venuePseudonym(pepper, "V-01");
      const full = await sender(hb).exec(base, "createVenueRecordFull", [sp, vp, CFG.T0, CFG.T0 + 3600, payload], 8_000_000);
      const hyb = await sender(hb).exec(crm, "createVenueRecord", [sp, vp, sha256Hex(payload), CFG.T0, CFG.T0 + 3600, 0, 0]);
      let fullTrace = { newSlots: null };
      let hybTrace = { newSlots: null };
      if (k === 0) {
        fullTrace = await newSlotsOf(provider, full.rc.transactionHash, base.address);
        hybTrace = await newSlotsOf(provider, hyb.rc.transactionHash, crm.address);
      }
      baseRows.push({ payloadBytes: size, design: "full-on-chain", gasUsed: full.gas, newSlots: fullTrace.newSlots ?? "" });
      baseRows.push({ payloadBytes: size, design: "PCTF-hybrid", gasUsed: hyb.gas, newSlots: hybTrace.newSlots ?? "" });
    }
  }
  // same 100 workload ciphertexts, stored fully on-chain
  const wlFull = [];
  for (let k = 0; k < 100; k++) {
    const st = W.stays[Math.floor((k * W.stays.length) / 100)];
    const full = await sender(hotelW[st.venueIdx]).exec(base, "createVenueRecordFull", [st.sp, st.vp, st.tStart, st.tEnd, st.ciphertext], 8_000_000);
    wlFull.push({ recordId: st.recordId, ciphertextBytes: st.ciphertext.length, fullGas: full.gas, hybridGas: recRows[st.recordId - 1].gasUsed });
  }
  writeCsv("e3_baseline_sizes.csv", baseRows);
  writeCsv("e3_baseline_workload.csv", wlFull);
  const bySize = {};
  for (const size of [256, 512, 1024, 2048, 4096]) {
    const f = baseRows.filter((r) => r.payloadBytes === size && r.design === "full-on-chain");
    const h = baseRows.filter((r) => r.payloadBytes === size && r.design === "PCTF-hybrid");
    bySize[size] = {
      fullGas: stats(f.map((r) => r.gasUsed)).mean,
      hybridGas: stats(h.map((r) => r.gasUsed)).mean,
      fullNewSlots: f.find((r) => r.newSlots !== "").newSlots,
      hybridNewSlots: h.find((r) => r.newSlots !== "").newSlots,
    };
    bySize[size].gasSavingPct = +(100 * (1 - bySize[size].hybridGas / bySize[size].fullGas)).toFixed(1);
    bySize[size].stateSavingPct = +(100 * (1 - bySize[size].hybridNewSlots / bySize[size].fullNewSlots)).toFixed(1);
  }
  const wf = stats(wlFull.map((r) => r.fullGas)).mean;
  const wh = stats(wlFull.map((r) => r.hybridGas)).mean;
  summary.E3 = { bySize, workload: { n: wlFull.length, fullGas: wf, hybridGas: wh, gasSavingPct: +(100 * (1 - wh / wf)).toFixed(1), ciphertextBytes: stats(wlFull.map((r) => r.ciphertextBytes)).mean } };
  console.log("E3", JSON.stringify(summary.E3.workload));

  // ------------------------------------------------ E5 diagnosis, matching, notification
  const tD = CFG.T0 + CFG.days * 86400;
  const tFrom = tD - CFG.windowDays * 86400;
  const staysBy = new Map();
  for (const st of W.stays) (staysBy.get(st.tourist) || staysBy.set(st.tourist, []).get(st.tourist)).push(st);
  const candidates = W.tourists.filter((t) => (staysBy.get(t) || []).some((s) => s.tEnd >= tFrom && !s.ttl));
  const diagnosed = [];
  while (diagnosed.length < CFG.diagnosed) {
    const t = pick(candidates);
    if (!diagnosed.includes(t)) diagnosed.push(t);
  }
  const diagRows = [];
  const notifyRows = [];
  let gtTotal = 0;
  let tp = 0;
  let fp = 0;
  let fn = 0;
  const exposedTourists = new Set();
  const ha = healthW[0];
  for (const t of diagnosed) {
    // ground truth from plaintext workload
    const mine = staysBy.get(t).filter((s) => s.tEnd >= tFrom && s.tStart <= tD);
    const gt = new Set();
    for (const s of mine) {
      const vs = Math.max(s.tStart, tFrom);
      const ve = Math.min(s.tEnd, tD);
      for (const o of W.stays) if (o.tourist !== t && o.venue === s.venue && o.tStart <= ve && vs <= o.tEnd) gt.add(o.sp.toLowerCase());
    }
    const ti = W.tourists.indexOf(t);
    const { ciphertext, dek } = encryptPayload({ patient: t, test: "PCR", result: "positive", sampledAt: tD - 7200 });
    const put = await storage.put(ciphertext);
    const dsp = subjectPseudonym(pepper, t, epochOf(tD));
    const dr = await sender(ha).exec(crm, "recordDiagnosis", [dsp, put.digest, tD, CFG.windowDays * 86400, 0, 0]);
    keystore.put(put.digest, dek, { owner: touristW[ti].address });
    const diagId = (await crm.recordCount()).toNumber();
    const t0 = now();
    // look back by the maximum stay length so stays that began before the window are covered
    const pseud = await krs.pseudonymsForDiagnosis(await sign(ha, "diagnosis-pseudonyms", t), t, tFrom - CFG.maxStayDays * 86400, tD);
    const m = await matchExposures(crm.connect(ha), pseud, tFrom, tD);
    const tMatch = ms(t0);
    const found = new Set(m.exposed);
    let tpi = 0;
    for (const x of found) gt.has(x) ? tpi++ : fp++;
    tp += tpi;
    fn += [...gt].filter((x) => !found.has(x)).length;
    gtTotal += gt.size;
    const list = [...found];
    for (let b = 0; b < list.length; b += 100) {
      const batch = list.slice(b, b + 100);
      const nr = await sender(ha).exec(crm, "notifyExposures", [diagId, batch], 8_000_000);
      notifyRows.push({ diagnosisId: diagId, batchSize: batch.length, gasUsed: nr.gas, gasPerNotice: (nr.gas / batch.length).toFixed(1) });
    }
    for (const s of W.stays) if (found.has(s.sp.toLowerCase())) exposedTourists.add(s.tourist);
    diagRows.push({ diagnosisId: diagId, diagnosisGas: dr.gas, windowPseudonyms: pseud.length, sourceVisits: m.sourceVisits, recordsScanned: m.scanned, groundTruth: gt.size, matched: found.size, truePositives: tpi, matchMs: tMatch.toFixed(1) });
  }
  // tourists check their own exposure on-chain
  let notifiedOk = 0;
  for (const t of exposedTourists) {
    const w = touristW[W.tourists.indexOf(t)];
    const own = await krs.ownPseudonyms(await sign(w, "pseudonyms", "self"), tFrom - 3 * 86400, tD);
    let hit = false;
    for (const p of own) if ((await crm.connect(w).getExposure(p)).toNumber() > 0) hit = true;
    if (hit) notifiedOk++;
  }
  let falseAlerts = 0;
  const negatives = W.tourists.filter((t) => !exposedTourists.has(t) && !diagnosed.includes(t));
  const negSample = negatives.slice(0, 200);
  for (const t of negSample) {
    const w = touristW[W.tourists.indexOf(t)];
    const own = await krs.ownPseudonyms(await sign(w, "pseudonyms", "self"), tFrom - 3 * 86400, tD);
    for (const p of own) if ((await crm.connect(w).getExposure(p)).toNumber() > 0) falseAlerts++;
  }
  // aggregates for the tourism authority
  const aggRows = [];
  for (let d = 0; d < CFG.days; d++) {
    const key = ethers.utils.formatBytes32String(`REGION-A:${d}`);
    const r = await sender(ha).exec(crm, "publishAggregate", [key, d === CFG.days - 1 ? diagnosed.length : 0, d === CFG.days - 1 ? exposedTourists.size : 0]);
    aggRows.push({ day: d, gasUsed: r.gas });
  }
  const agg = await crm.connect(tourismW[0]).getAggregate(ethers.utils.formatBytes32String(`REGION-A:${CFG.days - 1}`));
  writeCsv("e5_diagnosis_matching.csv", diagRows);
  writeCsv("e5_notifications.csv", notifyRows);
  summary.E5 = {
    diagnosed: diagnosed.length,
    windowDays: CFG.windowDays,
    groundTruthExposedPseudonyms: gtTotal,
    truePositives: tp,
    falsePositives: fp,
    falseNegatives: fn,
    precision: +(tp / Math.max(1, tp + fp)).toFixed(4),
    recall: +(tp / Math.max(1, tp + fn)).toFixed(4),
    exposedTourists: exposedTourists.size,
    exposedTouristsNotified: notifiedOk,
    negativeTouristsChecked: negSample.length,
    falseAlerts,
    diagnosisGas: stats(diagRows.map((r) => r.diagnosisGas)),
    matchMs: stats(diagRows.map((r) => +r.matchMs)),
    recordsScanned: stats(diagRows.map((r) => r.recordsScanned)),
    notifyBatches: notifyRows.length,
    notifyGasPerNotice: stats(notifyRows.map((r) => +r.gasPerNotice)),
    notifyGasPerBatch: stats(notifyRows.map((r) => r.gasUsed)),
    aggregateGas: stats(aggRows.map((r) => r.gasUsed)),
    aggregateReadByTourismAuthority: { cases: agg.cases, exposures: agg.exposures },
  };
  console.log("E5", JSON.stringify({ p: summary.E5.precision, r: summary.E5.recall, gt: gtTotal, notified: notifiedOk, exp: exposedTourists.size, fa: falseAlerts }));

  // ------------------------------------------------ E6 access-control matrix
  const revokedHotel = spare[0];
  const unregistered = spare[1];
  await sender(admin).exec(reg, "registerParticipant", [revokedHotel.address, 2, "Hotel-revoked"]);
  await sender(admin).exec(reg, "revokeParticipant", [revokedHotel.address]);
  const ownerHotel = hotelW[W.stays[0].venueIdx];
  const otherHotel = hotelW.find((h) => h.address !== ownerHotel.address);
  const venueRec = W.stays[0].recordId;
  const diagRec = diagRows[0].diagnosisId;
  const actors = {
    Admin: admin,
    Tourist: touristW[W.stays[0].touristIdx],
    "Hotel (owner)": ownerHotel,
    "Hotel (other)": otherHotel,
    HealthAuthority: healthW[1],
    TourismAuthority: tourismW[0],
    "Revoked hotel": revokedHotel,
    Unregistered: unregistered,
  };
  const fresh = () => ethers.Wallet.createRandom().address;
  const sp0 = W.stays[0].sp;
  const vp0 = W.stays[0].vp;
  const dg0 = W.stays[0].digest;
  const ops = [
    { op: "registerParticipant (tx)", allow: ["Admin"], tx: (w) => [reg, "registerParticipant", [fresh(), 1, ""]] },
    { op: "createVenueRecord (tx)", allow: ["Hotel (owner)", "Hotel (other)"], tx: () => [crm, "createVenueRecord", [sp0, vp0, dg0, CFG.T0, CFG.T0 + 60, 0, 0]] },
    { op: "updateRecordStatus venue (tx)", allow: ["Hotel (owner)"], tx: () => [crm, "updateRecordStatus", [venueRec, 0]] },
    { op: "recordDiagnosis (tx)", allow: ["HealthAuthority"], tx: () => [crm, "recordDiagnosis", [sp0, dg0, tD, 86400, 0, 0]] },
    { op: "notifyExposures (tx)", allow: ["HealthAuthority"], tx: () => [crm, "notifyExposures", [diagRec, [sp0]]] },
    { op: "publishAggregate (tx)", allow: ["HealthAuthority"], tx: () => [crm, "publishAggregate", [ethers.utils.formatBytes32String("REGION-B:0"), 1, 1]] },
    { op: "setPolicy (tx)", allow: ["Admin"], tx: () => [crm, "setPolicy", [4, 3, 0, true]] },
    { op: "setConsent (tx)", allow: ["Tourist"], tx: () => [crm, "setConsent", [true]] },
    { op: "getRecord venue (view)", allow: ["Hotel (owner)", "HealthAuthority"], call: (c) => c.getRecord(venueRec) },
    { op: "getRecord diagnostic (view)", allow: ["HealthAuthority"], call: (c) => c.getRecord(diagRec) },
    { op: "getSubjectRecordIds (view)", allow: ["HealthAuthority"], call: (c) => c.getSubjectRecordIds(sp0, 0, 10) },
    { op: "getVenueRecordIds (view)", allow: ["Hotel (owner)", "Hotel (other)", "HealthAuthority"], call: (c) => c.getVenueRecordIds(vp0, 0, 10) },
    { op: "getExposure (view)", allow: ["Tourist", "HealthAuthority"], call: (c) => c.getExposure(sp0) },
    { op: "getAggregate (view)", allow: ["Hotel (owner)", "Hotel (other)", "HealthAuthority", "TourismAuthority"], call: (c) => c.getAggregate(ethers.utils.formatBytes32String("REGION-A:0")) },
    { op: "key release venue record", allow: ["Tourist", "Hotel (owner)", "HealthAuthority"], rel: venueRec },
    { op: "key release diagnostic record", allow: ["HealthAuthority"], rel: diagRec },
  ];
  const matrix = [];
  for (const o of ops) {
    for (const [name, w] of Object.entries(actors)) {
      const expected = o.allow.includes(name);
      let observed;
      let gas = "";
      if (o.tx) {
        const [c, m, a] = o.tx(w);
        const r = await sender(w).exec(c, m, a, 600000);
        observed = r.ok;
        gas = r.gas;
      } else if (o.call) {
        observed = await o.call(crm.connect(w)).then(() => true, () => false);
      } else {
        observed = await krs.release(await sign(w, "release", o.rel)).then(() => true, () => false);
      }
      matrix.push({ operation: o.op, actor: name, expected: expected ? "allow" : "deny", observed: observed ? "allow" : "deny", match: expected === observed ? "yes" : "NO", gasUsed: gas });
    }
  }
  // restore policy change made by Admin during the matrix
  await sender(admin).exec(crm, "setPolicy", [4, 3, 0, true]);
  writeCsv("e6_access_matrix.csv", matrix);
  const denied = matrix.filter((m) => m.expected === "deny");
  const deniedTx = denied.filter((m) => m.gasUsed !== "");
  summary.E6 = {
    cases: matrix.length,
    matches: matrix.filter((m) => m.match === "yes").length,
    allowCases: matrix.filter((m) => m.expected === "allow").length,
    denyCases: denied.length,
    revertedTxGas: stats(deniedTx.map((m) => m.gasUsed)),
  };
  console.log("E6", JSON.stringify(summary.E6));

  // ------------------------------------------------ E7 security tests
  const sec = {};
  // (a) eth_call spoofing and raw storage reads expose public metadata
  const outsider = unregistered;
  const spoof = await crm.connect(provider).getRecord(diagRec, { from: healthW[1].address }).then(() => true, () => false);
  const slot = await provider.getStorageAt(crm.address, ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(["uint256", "uint256"], [venueRec, 2])));
  sec.ethCallSpoofSucceeds = spoof;
  sec.rawStorageRevealsPseudonym = slot.toLowerCase() === W.stays[0].sp.toLowerCase();
  // (b) payload stays protected: forged, replayed and stale key requests
  const forged = await sign(outsider, "release", venueRec);
  forged.claimedAddress = healthW[1].address;
  sec.forgedRequestDenied = await krs.release(forged).then(() => false, () => true);
  const good = await sign(healthW[1], "release", venueRec);
  await krs.release(good);
  sec.replayDenied = await krs.release(good).then(() => false, () => true);
  const stale = await sign(healthW[1], "release", venueRec);
  stale.ts -= 3600;
  stale.signature = await healthW[1].signMessage(challengeMessage("release", String(venueRec), stale.ts, stale.nonce));
  sec.staleDenied = await krs.release(stale).then(() => false, () => true);
  // (c) pseudonym reversal: old unsalted keccak vs keyed HMAC
  const oldIds = Array.from({ length: 999 }, (_, i) => `tourist_${String(i + 1).padStart(3, "0")}`);
  const oldTargets = new Set(Array.from({ length: 200 }, () => ethers.utils.keccak256(ethers.utils.toUtf8Bytes(pick(oldIds)))));
  let t0 = now();
  let recovered = 0;
  for (const id of oldIds) if (oldTargets.has(ethers.utils.keccak256(ethers.utils.toUtf8Bytes(id)))) recovered++;
  sec.oldSchemeDictionary = { candidates: oldIds.length, targets: oldTargets.size, recovered, ms: +ms(t0).toFixed(2) };
  const newTargets = new Set(W.stays.slice(0, 200).map((s) => s.sp.toLowerCase()));
  const guessPepper = crypto.randomBytes(32);
  t0 = now();
  let rec2 = 0;
  for (const id of W.tourists) for (let d = 0; d < CFG.days; d++) if (newTargets.has(subjectPseudonym(guessPepper, id, epochOf(CFG.T0) + d).toLowerCase())) rec2++;
  const ethTry = (id, d) => ethers.utils.keccak256(ethers.utils.toUtf8Bytes(`${id}:${d}`));
  for (const id of W.tourists) for (let d = 0; d < CFG.days; d++) if (newTargets.has(ethTry(id, epochOf(CFG.T0) + d))) rec2++;
  sec.hmacSchemeDictionary = { candidates: W.tourists.length * CFG.days * 2, targets: newTargets.size, recovered: rec2, ms: +ms(t0).toFixed(2) };
  // (d) cross-day linkability of a tourist's records
  let multi = 0;
  let linkableOld = 0;
  let linkableNew = 0;
  for (const [, list] of staysBy) {
    if (list.length < 2) continue;
    multi++;
    linkableOld++; // a static pseudonym links every record of the subject
    const ps = new Set(list.map((s) => s.sp));
    if (ps.size < list.length) linkableNew++;
  }
  sec.linkability = { touristsWithMultipleStays: multi, linkableStatic: linkableOld, linkableEpochPseudonyms: linkableNew };
  // (e) tampering
  let detected = 0;
  const tamperSet = W.stays.filter((s) => !s.ttl).slice(100, 120);
  for (const s of tamperSet) {
    const f = path.join(dataDir, "objects", s.digest.slice(2) + ".bin");
    const b = fs.readFileSync(f);
    b[Math.floor(b.length / 2)] ^= 0x01;
    fs.writeFileSync(f, b);
    const r = await krs.release(await sign(healthW[2], "release", s.recordId)).then(() => "ok", (e) => e.message);
    if (/integrity/.test(r)) detected++;
  }
  sec.tamper = { modified: tamperSet.length, detected };
  // (f) consent withdrawal -> crypto-shredding
  const withdrawTourists = [...new Set(W.stays.filter((s) => !s.ttl).slice(300, 340).map((s) => s.touristIdx))].slice(0, 20);
  let shredded = 0;
  let deniedAfter = 0;
  let attempts = 0;
  for (const ti of withdrawTourists) {
    await sender(touristW[ti]).exec(crm, "setConsent", [false]);
    shredded += krs.onConsentWithdrawn(touristW[ti].address);
    for (const s of staysBy.get(W.tourists[ti])) {
      attempts++;
      const ok = await krs.release(await sign(healthW[3], "release", s.recordId)).then(() => true, () => false);
      if (!ok) deniedAfter++;
    }
  }
  let othersOk = 0;
  const others = W.stays.filter((s) => !s.ttl && !withdrawTourists.includes(s.touristIdx) && !tamperSet.includes(s)).slice(500, 550);
  for (const s of others) if (await krs.release(await sign(healthW[3], "release", s.recordId)).then(() => true, () => false)) othersOk++;
  sec.consentWithdrawal = { tourists: withdrawTourists.length, objectsShredded: shredded, releaseAttempts: attempts, denied: deniedAfter, unaffectedChecked: others.length, unaffectedReleased: othersOk };
  // (g) retention (TTL)
  await provider.send("evm_increaseTime", [4 * 86400]);
  await provider.send("evm_mine", []);
  const chainNow = (await provider.getBlock("latest")).timestamp;
  const purged = keystore.purgeExpired(Math.floor(Date.now() / 1000) + 4 * 86400);
  krs.nowFn = () => chainNow;
  let ttlDenied = 0;
  const ttlStays = W.stays.filter((s) => s.ttl);
  for (const s of ttlStays) {
    const auth = await sign(healthW[4], "release", s.recordId);
    auth.ts = chainNow;
    auth.signature = await healthW[4].signMessage(challengeMessage("release", String(s.recordId), auth.ts, auth.nonce));
    if (!(await krs.release(auth).then(() => true, () => false))) ttlDenied++;
  }
  krs.nowFn = () => Math.floor(Date.now() / 1000);
  sec.retention = { recordsWithTtl: ttlStays.length, keysPurged: purged, releaseDenied: ttlDenied };
  sec.auditLog = audit.verify();
  summary.E7 = sec;
  console.log("E7", JSON.stringify(sec));

  // ------------------------------------------------ E8 key-release latency
  const relRows = [];
  const pool = W.stays.filter((s) => !s.ttl && !withdrawTourists.includes(s.touristIdx) && !tamperSet.includes(s));
  for (let k = 0; k < CFG.releaseSample; k++) {
    const s = pool[Math.floor((k * pool.length) / CFG.releaseSample)];
    const tS = now();
    const auth = await sign(healthW[5], "release", s.recordId);
    const tSign = ms(tS);
    const t1 = now();
    await krs.release(auth);
    relRows.push({ recordId: s.recordId, signMs: tSign.toFixed(3), releaseMs: ms(t1).toFixed(3) });
  }
  for (let k = 0; k < 100; k++) {
    const s = pool[Math.floor((k * pool.length) / 100)];
    const w = touristW[s.touristIdx];
    const t1 = now();
    await krs.release(await sign(w, "release", s.recordId));
    relRows.push({ recordId: s.recordId, signMs: "", releaseMs: ms(t1).toFixed(3), requester: "tourist-self" });
  }
  writeCsv("e8_key_release.csv", relRows.map((r) => ({ requester: r.requester || "health-authority", ...r })));
  const haRel = relRows.filter((r) => !r.requester).map((r) => +r.releaseMs);
  const tRel = relRows.filter((r) => r.requester).map((r) => +r.releaseMs);
  summary.E8 = { healthAuthorityReleaseMs: stats(haRel), touristSelfReleaseMs: stats(tRel), signMs: stats(relRows.filter((r) => r.signMs !== "").map((r) => +r.signMs)) };
  summary.endToEndWriteMs = +(summary.E2.encryptMs.mean + summary.E2.storeMs.mean + summary.E2.txLatencyMs.mean).toFixed(2);
  console.log("E8", JSON.stringify(summary.E8.healthAuthorityReleaseMs));

  // ------------------------------------------------ E9 IPFS (Helia blockstore) timing
  const ipfs = new StorageService({ dataDir: path.join(dataDir, "ipfs"), mode: "ipfs" });
  const ipRows = [];
  for (let k = 0; k < CFG.ipfsSample; k++) {
    const s = W.stays[Math.floor((k * W.stays.length) / CFG.ipfsSample)];
    const t1 = now();
    const put = await ipfs.put(s.ciphertext);
    const tPut = ms(t1);
    const t2 = now();
    const back = await ipfs.get(put.digest, 1);
    const tGet = ms(t2);
    ipRows.push({ recordId: s.recordId, bytes: s.ciphertext.length, putMs: tPut.toFixed(3), getVerifyMs: tGet.toFixed(3), digestMatchesChain: put.digest === s.digest && back.equals(s.ciphertext) ? "yes" : "no", cid: put.ref });
  }
  await ipfs.close();
  writeCsv("e9_ipfs.csv", ipRows);
  summary.E9 = { n: ipRows.length, putMs: stats(ipRows.map((r) => +r.putMs)), getVerifyMs: stats(ipRows.map((r) => +r.getVerifyMs)), digestMatches: ipRows.filter((r) => r.digestMatchesChain === "yes").length };
  console.log("E9", JSON.stringify(summary.E9.putMs));

  await server.close();

  // E4 (throughput under block times) runs separately: scripts/experiments/throughput.js

  fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 2));
  console.log("done ->", OUT);
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
