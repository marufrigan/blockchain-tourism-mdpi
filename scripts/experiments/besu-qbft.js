/**
 * Multi-node experiments on a four-validator Hyperledger Besu QBFT network (2 s blocks,
 * 30 M gas, zero base fee) created with scripts/besu/setup-qbft.sh and started with
 * scripts/besu/run-network.sh. Nodes expose JSON-RPC on 127.0.0.1:8545..8548.
 *   BESU=/path/to/bin/besu node scripts/experiments/besu-qbft.js <network workdir> [records=1500]
 * Measures:
 *   E15 record creation and throughput across validators, cross-node visibility,
 *       key-release concurrency against a validator's RPC, validator faults and recovery;
 *   E19 revocation-to-enforcement delay (role revocation, consent withdrawal, policy change)
 *       observed by a key-release service attached to a different validator than the writer.
 * Writes results/e15_*.csv, results/e19_revocation_delay.csv and keys E15, E19 in summary.json.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { ethers } = require("ethers");
const { deploySystem } = require("../../backend/src/lib/contracts");
const { encryptPayload } = require("../../backend/src/utils/crypto");
const { subjectPseudonym, venuePseudonym, epochOf } = require("../../backend/src/utils/pseudonym");
const { StorageService } = require("../../backend/src/services/storage.service");
const { KeyStore } = require("../../backend/src/services/keystore.service");
const { AuditLog } = require("../../backend/src/services/audit.service");
const { KeyReleaseService, challengeMessage } = require("../../backend/src/services/keyRelease.service");
const { stats, writeCsv, mergeSummary, buildWorkload, Sender, ms, now, sleep } = require("./lib");

const WD = process.argv[2];
const NREC = Number(process.argv[3] || 1500);
const ONLY = process.env.ONLY || null; // run one part: writes | revocation | concurrency | throughput | faults
const run = (k) => !ONLY || ONLY === k;
if (!WD) throw new Error("usage: besu-qbft.js <network workdir> [records]");
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const P = [8545, 8546, 8547, 8548].map((p) => {
  const pr = new ethers.providers.StaticJsonRpcProvider(`http://127.0.0.1:${p}`, { chainId: 1337, name: "qbft" });
  pr.pollingInterval = 50;
  return pr;
});
const wallet = (i, p = P[0]) => new ethers.Wallet(ethers.utils.keccak256(ethers.utils.toUtf8Bytes(`pctf-besu-${i}`)), p);
const sendr = (w) => new Sender(w, { gasPrice: 0 });

async function sign(w, action, target) {
  const ts = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(12).toString("hex");
  return { target: String(target), ts, nonce, signature: await w.signMessage(challengeMessage(action, String(target), ts, nonce)), claimedAddress: w.address };
}
const tryRelease = (krs, a) => krs.release(a).then(() => "GRANT", (e) => e.message.replace(/^denied: /, ""));
const head = (i) => P[i].getBlockNumber().catch(() => null);

function stopNode(i) {
  const pid = Number(fs.readFileSync(path.join(WD, `node${i}.pid`), "utf8"));
  try {
    process.kill(pid, "SIGTERM");
  } catch (_) {}
  return pid;
}
function startNode(i) {
  const out = fs.openSync(path.join(WD, `node${i}.log`), "a");
  const c = spawn(path.join(__dirname, "..", "besu", "start-node.sh"), [WD, String(i)], { detached: true, stdio: ["ignore", out, out], env: process.env });
  c.unref();
  fs.writeFileSync(path.join(WD, `node${i}.pid`), String(c.pid));
}
async function waitFor(fn, timeoutMs, step = 100) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return Date.now() - t0;
    if (Date.now() - t0 > timeoutMs) return null;
    await sleep(step);
  }
}

(async () => {
  const out = { network: { validators: 4, consensus: "QBFT", blockPeriodSec: 2, gasLimit: 30000000, host: `${os.cpus().length} vCPU, ${Math.round(os.totalmem() / 2 ** 30)} GB, all validators on one host`, client: "Hyperledger Besu 25.10.0" } };
  const admin = wallet(0);
  const hotels = Array.from({ length: 30 }, (_, i) => wallet(1 + i));
  const HA = Array.from({ length: 4 }, (_, i) => wallet(31 + i));
  const tourists = Array.from({ length: 20 }, (_, i) => wallet(35 + i));
  const spare = Array.from({ length: 9 }, (_, i) => wallet(55 + i));
  const sys = await deploySystem(admin);
  const reg = sys.registry.contract;
  const crm = sys.crm.contract;
  out.deployGas = { ParticipantRegistry: sys.registry.gasUsed, ContactRecordManager: sys.crm.gasUsed };
  const sa = sendr(admin);
  let last;
  for (const h of hotels) last = await sa.fire(reg, "registerParticipant", [h.address, 2, "H"]);
  for (const h of HA) last = await sa.fire(reg, "registerParticipant", [h.address, 3, "HA"]);
  for (const t of tourists) last = await sa.fire(reg, "registerParticipant", [t.address, 1, ""]);
  await last.wait();
  for (const t of tourists) last = await sendr(t).fire(crm, "setConsent", [true]);
  await last.wait();
  log("deployed and registered");

  // ------------------------------------------------ E15a: sequential record creation, write on node1
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pctf-besu-"));
  const pepper = crypto.randomBytes(32);
  const kek = crypto.randomBytes(32);
  const storage = new StorageService({ dataDir, mode: "local" });
  const keystore = new KeyStore({ dataDir, kek });
  const audit = new AuditLog({ dataDir });
  const W = buildWorkload();
  const recs = [];
  const seqRows = [];
  const H = new Map(hotels.map((h) => [h.address, sendr(h)]));
  for (let i = 0; i < (run("writes") || run("revocation") || run("concurrency") ? 60 : 0); i++) {
    const st = W.stays[i];
    const hotel = hotels[st.venueIdx];
    const owner = tourists[st.touristIdx % tourists.length];
    const { ciphertext, dek } = encryptPayload(st.payload);
    const put = await storage.put(ciphertext);
    const sp = subjectPseudonym(pepper, st.tourist, epochOf(st.tStart));
    const vp = venuePseudonym(pepper, st.venue);
    const x = await H.get(hotel.address).exec(crm, "createVenueRecord", [sp, vp, put.digest, st.tStart, st.tEnd, 0, put.scheme]);
    keystore.put(put.digest, dek, { owner: owner.address });
    const id = (await crm.recordCount()).toNumber();
    // cross-node visibility: when does node3 serve the receipt the writer already has?
    const vis = await waitFor(() => P[2].getTransactionReceipt(x.rc.transactionHash), 10000, 10);
    recs.push({ id, owner, digest: put.digest });
    seqRows.push({ index: i + 1, gasUsed: x.gas, latencyMs: x.latency.toFixed(1), node3ExtraMs: vis, status: x.ok ? "success" : "fail" });
  }
  if (run("writes")) writeCsv("e15_sequential_writes.csv", seqRows);
  out.sequentialWrites = { n: seqRows.length, success: seqRows.filter((r) => r.status === "success").length, gas: stats(seqRows.map((r) => r.gasUsed)), latencyMs: stats(seqRows.map((r) => +r.latencyMs)), node3ExtraMs: stats(seqRows.map((r) => r.node3ExtraMs)) };
  log("E15a", JSON.stringify(out.sequentialWrites));

  // ------------------------------------------------ E19: revocation-to-enforcement delay (writer node1, KRS on node2)
  const krs = new KeyReleaseService({ registry: reg.connect(P[1]), crm: crm.connect(P[1]), keystore, storage, audit, pepper });
  const delayRows = [];
  async function measure(kind, requester, recordId, change, expectReason) {
    const pre = await tryRelease(krs, await sign(requester, "release", recordId));
    const t0 = now();
    const tx = await change();
    let included = null;
    tx.wait().then(() => (included = ms(t0)));
    let granted = 0;
    let denied = null;
    while (ms(t0) < 30000) {
      const r = await tryRelease(krs, await sign(requester, "release", recordId));
      if (r === "GRANT") granted++;
      else if (r === expectReason) {
        denied = ms(t0);
        break;
      }
      await sleep(25);
    }
    await tx.wait();
    delayRows.push({ kind, preChange: pre, enforcementMs: denied && denied.toFixed(1), writerReceiptMs: included && included.toFixed(1), grantsDuringWindow: granted });
  }
  if (run("revocation")) for (let k = 0; k < 20; k++) {
    const w = wallet(1000 + Date.now() % 100000 + k, P[0]);
    await sa.exec(reg, "registerParticipant", [w.address, 3, "HA-t"]);
    await measure("role revocation", w, recs[k].id, () => sa.fire(reg, "revokeParticipant", [w.address]), "not an active participant");
  }
  if (run("revocation")) for (let k = 0; k < 10; k++) {
    const r = recs.find((x) => x.owner.address === tourists[k].address);
    if (!r) continue;
    const st = sendr(tourists[k]);
    await measure("consent withdrawal", HA[0], r.id, () => st.fire(crm, "setConsent", [false]), "subject consent withdrawn");
    await st.exec(crm, "setConsent", [true]);
  }
  if (run("revocation")) for (let k = 0; k < 10; k++) {
    await measure("policy change", HA[1], recs[30 + k].id, () => sa.fire(crm, "setPolicy", [3, 1, 0, false]), "on-chain policy denied");
    await sa.exec(crm, "setPolicy", [3, 1, 0, true]);
  }
  if (run("revocation")) writeCsv("e19_revocation_delay.csv", delayRows);
  out.E19 = {};
  for (const kind of ["role revocation", "consent withdrawal", "policy change"]) {
    const r = delayRows.filter((x) => x.kind === kind);
    out.E19[kind] = { trials: r.length, enforced: r.filter((x) => x.enforcementMs).length, enforcementMs: stats(r.filter((x) => x.enforcementMs).map((x) => +x.enforcementMs)), writerReceiptMs: stats(r.filter((x) => x.writerReceiptMs).map((x) => +x.writerReceiptMs)), grantsDuringWindow: stats(r.map((x) => x.grantsDuringWindow)) };
  }
  log("E19", JSON.stringify(out.E19));

  // ------------------------------------------------ E15b: key-release concurrency against node2
  out.releaseConcurrency = {};
  const crow = [];
  for (const c of run("concurrency") ? [1, 8, 32, 128] : []) {
    const total = 256;
    const reqs = [];
    for (let k = 0; k < total; k++) reqs.push(await sign(HA[k % 4], "release", recs[(k * 7) % recs.length].id));
    const lat = [];
    let granted = 0;
    let idx = 0;
    const t0 = now();
    await Promise.all(Array.from({ length: c }, async () => {
      while (idx < total) {
        const a = reqs[idx++];
        const t1 = now();
        if ((await tryRelease(krs, a)) === "GRANT") granted++;
        lat.push(ms(t1));
      }
    }));
    const wall = ms(t0) / 1000;
    const s = stats(lat);
    crow.push({ concurrency: c, requests: total, granted, throughputPerSec: +(total / wall).toFixed(1), p50Ms: s.p50, p95Ms: s.p95, maxMs: s.max });
    out.releaseConcurrency[c] = crow[crow.length - 1];
    log("E15b", JSON.stringify(crow[crow.length - 1]));
  }
  if (run("concurrency")) writeCsv("e15_release_concurrency.csv", crow);

  // ------------------------------------------------ E15c: throughput, writes spread over the four validators
  const iface = crm.interface;
  const nonces = await Promise.all(hotels.map((h) => h.getTransactionCount("pending")));
  const signed = [];
  for (let i = 0; i < (run("throughput") ? NREC : 0); i++) {
    const hi = i % hotels.length;
    const data = iface.encodeFunctionData("createVenueRecord", [
      ethers.utils.hexlify(crypto.randomBytes(32)), ethers.utils.hexlify(crypto.randomBytes(32)), ethers.utils.hexlify(crypto.randomBytes(32)),
      1772409600 + i * 60, 1772409600 + i * 60 + 3600, 0, 0,
    ]);
    signed.push(await hotels[hi].signTransaction({ to: crm.address, data, gasLimit: 300000, gasPrice: 0, nonce: nonces[hi]++, chainId: 1337, type: 0 }));
  }
  const startBlock = await P[0].getBlockNumber();
  const sentAt = new Map();
  const rows = [];
  let next = startBlock + 1;
  async function scan() {
    const h = await P[0].getBlockNumber();
    for (; next <= h; next++) {
      const b = await P[0].getBlock(next);
      const seen = process.hrtime.bigint();
      for (const tx of b.transactions) {
        if (!sentAt.has(tx)) continue;
        const rc = await P[0].getTransactionReceipt(tx);
        rows.push({ latencyMs: Number(seen - sentAt.get(tx)) / 1e6, block: b.number, gasUsed: rc.gasUsed.toNumber(), status: rc.status === 1 ? "success" : "fail" });
      }
    }
  }
  const t0 = process.hrtime.bigint();
  // submit in rounds of 100 (just under one block); each hotel uses its own validator (hotel index mod 4)
  for (let i = 0; i < signed.length; i += 100) {
    await Promise.all(signed.slice(i, i + 100).map(async (raw, k) => {
      const tS = process.hrtime.bigint();
      const hash = await P[((i + k) % hotels.length) % 4].send("eth_sendRawTransaction", [raw]);
      sentAt.set(hash, tS);
    }));
    while (sentAt.size - rows.length > 150) {
      await scan();
      await sleep(100);
    }
  }
  let lastProgress = Date.now();
  let lastCount = rows.length;
  while (rows.length < sentAt.size && Date.now() - lastProgress < 30000) {
    await scan();
    if (rows.length !== lastCount) {
      lastCount = rows.length;
      lastProgress = Date.now();
    }
    await sleep(100);
  }
  const elapsed = Number(process.hrtime.bigint() - t0) / 1e9;
  const per = {};
  rows.forEach((r) => (per[r.block] = (per[r.block] || 0) + 1));
  if (run("throughput")) writeCsv("e15_throughput.csv", rows.map((r) => ({ ...r, latencyMs: r.latencyMs.toFixed(1) })));
  out.throughput = {
    submitted: sentAt.size, included: rows.length, success: rows.filter((r) => r.status === "success").length, elapsedSec: +elapsed.toFixed(1),
    throughputPerSec: +(rows.length / elapsed).toFixed(2), blocksUsed: Object.keys(per).length, recordsPerBlock: stats(Object.values(per)),
    inclusionLatencyMs: stats(rows.map((r) => r.latencyMs)), gas: stats(rows.map((r) => r.gasUsed)),
  };
  log("E15c", JSON.stringify(out.throughput));

  // ------------------------------------------------ E15d: validator faults
  for (const s of H.values()) s.nonce = null; // throughput used pre-signed transactions
  const faults = {};
  if (!run("faults")) {
    const prev = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "results", "summary.json"), "utf8"));
    const merged = { ...(prev.E15 || {}) };
    if (run("throughput")) merged.throughput = out.throughput;
    if (run("concurrency")) merged.releaseConcurrency = out.releaseConcurrency;
    if (run("writes")) merged.sequentialWrites = out.sequentialWrites;
    mergeSummary("E15", merged);
    if (run("revocation")) mergeSummary("E19", out.E19);
    process.exit(0);
  }
  const blockRate = async (sec, i = 0) => {
    const a = await head(i);
    await sleep(sec * 1000);
    const b = await head(i);
    return a === null || b === null ? null : (b - a) / sec;
  };
  faults.blocksPerSecAll4 = await blockRate(20);
  stopNode(4);
  await sleep(3000);
  faults.blocksPerSecNode4Down = await blockRate(20);
  const lat3 = [];
  for (let k = 0; k < 10; k++) {
    const x = await H.get(hotels[k].address).exec(crm, "createVenueRecord", [ethers.utils.hexlify(crypto.randomBytes(32)), ethers.utils.hexlify(crypto.randomBytes(32)), ethers.utils.hexlify(crypto.randomBytes(32)), 1772409600, 1772413200, 0, 0]);
    lat3.push(x.latency);
  }
  faults.writeLatencyMsNode4Down = stats(lat3);
  stopNode(3);
  await sleep(3000);
  const h0 = await head(0);
  const pendingTx = await H.get(hotels[11].address).fire(crm, "createVenueRecord", [ethers.utils.hexlify(crypto.randomBytes(32)), ethers.utils.hexlify(crypto.randomBytes(32)), ethers.utils.hexlify(crypto.randomBytes(32)), 1772409600, 1772413200, 0, 0]);
  await sleep(30000);
  const h1 = await head(0);
  faults.twoDown = { blocksIn30s: h1 - h0, pendingTxIncluded: Boolean(await P[0].getTransactionReceipt(pendingTx.hash)) };
  // reads and key release keep working on the surviving nodes while the chain is halted
  const k2 = await tryRelease(krs, await sign(HA[2], "release", recs[5].id));
  faults.twoDown.releaseWhileHalted = k2;
  const tRestart = Date.now();
  startNode(3);
  const firstBlockMs = await waitFor(async () => (await head(0)) > h1, 300000, 250);
  const includedMs = await waitFor(async () => Boolean(await P[0].getTransactionReceipt(pendingTx.hash)), 300000, 250);
  faults.node3Restarted = { firstNewBlockMs: firstBlockMs, pendingTxIncludedMs: includedMs, sinceRestartMs: Date.now() - tRestart };
  startNode(4);
  const tgt = await head(0);
  const syncMs = await waitFor(async () => (await head(3)) >= tgt, 300000, 250);
  faults.node4Restarted = { headAtRestart: tgt, caughtUpMs: syncMs };
  faults.blocksPerSecRecovered = await blockRate(20);
  out.faults = faults;
  log("E15d", JSON.stringify(faults));

  mergeSummary("E15", { ...out, E19: undefined });
  mergeSummary("E19", out.E19);
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
