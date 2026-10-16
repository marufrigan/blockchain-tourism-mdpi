/**
 * E4: throughput and inclusion latency with a 2 s block time and a 30 M gas limit.
 *   node scripts/experiments/throughput.js [records=1500] [hotels=30]
 * Merges results into results/summary.json (key E4) and writes results/e4_throughput_<bt>s.csv.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const ganache = require("ganache");
const { ethers } = require("ethers");
const { deploySystem } = require("../../backend/src/lib/contracts");

const OUT = path.join(__dirname, "..", "..", "results");
const N = Number(process.argv[2] || 1500);
const H = Number(process.argv[3] || 30);
const T0 = 1772409600;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

function stats(arr) {
  const a = [...arr].sort((x, y) => x - y);
  const n = a.length;
  const mean = a.reduce((s, x) => s + x, 0) / n;
  const sd = Math.sqrt(a.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, n - 1));
  const q = (p) => a[Math.min(n - 1, Math.floor(p * (n - 1)))];
  return { n, mean: +mean.toFixed(2), sd: +sd.toFixed(2), min: a[0], p50: q(0.5), p95: q(0.95), max: a[n - 1] };
}

async function run(blockTime, port) {
  const keys = Array.from({ length: H + 1 }, () => ethers.Wallet.createRandom().privateKey);
  const server = ganache.server({
    logging: { quiet: true },
    chain: { chainId: 1337, hardfork: "shanghai" },
    miner: { blockGasLimit: 30_000_000, blockTime },
    wallet: { accounts: keys.map((k) => ({ secretKey: k, balance: "0x" + (10n ** 22n).toString(16) })) },
  });
  await new Promise((r) => server.listen(port, r));
  const provider = new ethers.providers.StaticJsonRpcProvider(`http://127.0.0.1:${port}`, { chainId: 1337, name: "ganache" });
  const ws = keys.map((k) => new ethers.Wallet(k, provider));
  const sys = await deploySystem(ws[0]);
  log(`bt=${blockTime}s deployed`);
  const reg = sys.registry.contract.connect(ws[0]);
  let n0 = await ws[0].getTransactionCount("pending");
  const regs = [];
  for (const h of ws.slice(1)) regs.push(await reg.registerParticipant(h.address, 2, "H", { nonce: n0++, gasLimit: 200000, gasPrice: 1e9, type: 0 }));
  await regs[regs.length - 1].wait();
  log(`bt=${blockTime}s hotels registered`);
  const iface = sys.crm.contract.interface;
  const hotels = ws.slice(1);
  const nonces = await Promise.all(hotels.map((h) => h.getTransactionCount("pending")));
  // pre-sign all transactions so submission measures the network path only
  const signed = [];
  for (let i = 0; i < N; i++) {
    const hi = i % hotels.length;
    const data = iface.encodeFunctionData("createVenueRecord", [
      ethers.utils.hexlify(crypto.randomBytes(32)), ethers.utils.hexlify(crypto.randomBytes(32)), ethers.utils.hexlify(crypto.randomBytes(32)),
      T0 + i * 60, T0 + i * 60 + 3600, 0, 0,
    ]);
    signed.push(await hotels[hi].signTransaction({ to: sys.crm.address, data, gasLimit: 300000, gasPrice: 1e9, nonce: nonces[hi]++, chainId: 1337, type: 0 }));
  }
  const startBlock = await provider.getBlockNumber();
  const sentAt = new Map();
  const rows = [];
  let next = startBlock + 1;
  // Scan newly mined blocks and record inclusion latency for our transactions.
  async function scan() {
    const head = await provider.getBlockNumber();
    for (; next <= head; next++) {
      const b = await provider.getBlock(next);
      const seen = process.hrtime.bigint();
      for (const h of b.transactions) {
        if (!sentAt.has(h)) continue;
        const rc = await provider.getTransactionReceipt(h);
        rows.push({ latencyMs: Number(seen - sentAt.get(h)) / 1e6, block: b.number, gasUsed: rc.gasUsed.toNumber(), status: rc.status === 1 ? "success" : "fail" });
      }
    }
  }
  const t0 = process.hrtime.bigint();
  // Ganache 7 silently drops pending transactions once a block is full, so clients keep at most MAX_IN_FLIGHT unconfirmed (just under one block of PCTF records).
  const MAX_IN_FLIGHT = Number(process.env.MAX_IN_FLIGHT || 100);
  let lost = 0;
  for (const raw of signed) {
    let waitStart = Date.now();
    let seenRows = rows.length;
    while (sentAt.size - rows.length - lost >= MAX_IN_FLIGHT) {
      await scan();
      if (rows.length !== seenRows) {
        seenRows = rows.length;
        waitStart = Date.now();
      } else if (Date.now() - waitStart > 5 * blockTime * 1000 + 10000) {
        lost = sentAt.size - rows.length; // count unconfirmed transactions as dropped and continue
        log(`bt=${blockTime}s ${lost} transactions dropped so far`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    const tS = process.hrtime.bigint();
    const hash = await provider.send("eth_sendRawTransaction", [raw]);
    sentAt.set(hash, tS);
  }
  const submitSec = Number(process.hrtime.bigint() - t0) / 1e9;
  log(`bt=${blockTime}s submitted ${sentAt.size} in ${submitSec.toFixed(1)} s`);
  let lastProgress = Date.now();
  let lastCount = rows.length;
  while (rows.length < sentAt.size) {
    await scan();
    if (rows.length !== lastCount) {
      lastCount = rows.length;
      lastProgress = Date.now();
    } else if (Date.now() - lastProgress > 5 * blockTime * 1000 + 10000) {
      log(`bt=${blockTime}s stalled: ${sentAt.size - rows.length} transactions not included`);
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  const elapsed = Number(process.hrtime.bigint() - t0) / 1e9;
  const per = {};
  rows.forEach((r) => (per[r.block] = (per[r.block] || 0) + 1));
  fs.writeFileSync(path.join(OUT, `e4_throughput_${blockTime}s.csv`), ["latencyMs,block,gasUsed,status", ...rows.map((r) => `${r.latencyMs.toFixed(1)},${r.block},${r.gasUsed},${r.status}`)].join("\n"));
  await server.close();
  const res = {
    submitted: sentAt.size,
    dropped: sentAt.size - rows.length,
    maxInFlight: MAX_IN_FLIGHT,
    records: rows.length,
    success: rows.filter((r) => r.status === "success").length,
    submitSec: +submitSec.toFixed(1),
    elapsedSec: +elapsed.toFixed(1),
    throughputPerSec: +(rows.length / elapsed).toFixed(2),
    blocksUsed: Object.keys(per).length,
    recordsPerBlock: stats(Object.values(per)),
    inclusionLatencyMs: stats(rows.map((r) => r.latencyMs)),
    gas: stats(rows.map((r) => r.gasUsed)),
  };
  log(`bt=${blockTime}s`, JSON.stringify(res));
  return res;
}

(async () => {
  const only = process.env.ONLY_BT ? Number(process.env.ONLY_BT) : null;
  // Default: 2 s blocks (permissioned-network setting). Longer block times can be run with ONLY_BT=12,
  // but Ganache 7 drops long-pending transactions, so those runs lose records and are not reported.
  const bt = only || 2;
  const E4 = { records: N, hotels: H, gasLimit: 30000000, [`blockTime${bt}s`]: await run(bt, 18600 + bt) };
  const f = path.join(OUT, "summary.json");
  const s = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {};
  s.E4 = E4;
  fs.writeFileSync(f, JSON.stringify(s, null, 2));
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
