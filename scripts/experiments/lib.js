/** Shared helpers for the extended experiments (same RNG and workload generator as run-all.js). */
const fs = require("fs");
const path = require("path");
const ganache = require("ganache");
const { ethers } = require("ethers");

const OUT = path.join(__dirname, "..", "..", "results");
fs.mkdirSync(OUT, { recursive: true });

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

function stats(arr) {
  const a = [...arr].sort((x, y) => x - y);
  const n = a.length;
  if (!n) return { n: 0 };
  const mean = a.reduce((s, x) => s + x, 0) / n;
  const sd = Math.sqrt(a.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, n - 1));
  const q = (p) => a[Math.min(n - 1, Math.floor(p * (n - 1)))];
  const r = (x) => +Number(x).toFixed(3);
  return { n, mean: r(mean), sd: r(sd), min: r(a[0]), p50: r(q(0.5)), p95: r(q(0.95)), max: r(a[n - 1]) };
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

function mergeSummary(key, value) {
  const f = path.join(OUT, "summary.json");
  const s = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {};
  s[key] = value;
  fs.writeFileSync(f, JSON.stringify(s, null, 2));
}

/**
 * Venue-stay workload. With the default parameters (seed 20260302, 950 tourists, 30 venues)
 * it reproduces exactly the stays of run-all.js (same draw order).
 */
function buildWorkload({ seed = 20260302, tourists = 950, venues = 30, days = 14, T0 = 1772409600 } = {}) {
  const R = rng(seed);
  const ri = (lo, hi) => lo + Math.floor(R() * (hi - lo + 1));
  const pick = (a) => a[Math.floor(R() * a.length)];
  const areas = ["lobby", "restaurant", "lift", "gym", "pool", "bar", "spa", "conference"];
  const T = Array.from({ length: tourists }, (_, i) => `T-${String(i + 1).padStart(4, "0")}`);
  const V = Array.from({ length: venues }, (_, i) => `V-${String(i + 1).padStart(2, "0")}`);
  const stays = [];
  for (const [ti, t] of T.entries()) {
    const n = ri(1, 3);
    for (let k = 0; k < n; k++) {
      const v = ri(0, V.length - 1);
      const day = ri(0, days - 2);
      const tStart = T0 + day * 86400 + ri(12, 22) * 3600 + ri(0, 59) * 60;
      const tEnd = tStart + ri(1, 3) * 86400 - ri(1, 6) * 3600;
      const log = Array.from({ length: ri(2, 12) }, () => ({ area: pick(areas), at: ri(tStart, tEnd) }));
      stays.push({
        tourist: t, touristIdx: ti, venue: V[v], venueIdx: v, tStart, tEnd,
        payload: { guestRef: t, venue: V[v], room: String(ri(100, 899)), partySize: ri(1, 4), checkIn: tStart, checkOut: tEnd, visitLog: log, note: "synthetic record for evaluation only" },
      });
    }
  }
  stays.sort((a, b) => a.tStart - b.tStart);
  return { tourists: T, venues: V, stays, R };
}

async function startGanache(port, keys, opts = {}) {
  const server = ganache.server({
    logging: { quiet: true },
    chain: { chainId: 1337, hardfork: "shanghai" },
    miner: opts.blockTime ? { blockGasLimit: 30_000_000, blockTime: opts.blockTime } : { blockGasLimit: 30_000_000, instamine: "eager" },
    wallet: { accounts: keys.map((k) => ({ secretKey: k, balance: "0x" + (10n ** 22n).toString(16) })) },
  });
  await new Promise((res, rej) => server.listen(port, (e) => (e ? rej(e) : res())));
  const provider = new ethers.providers.JsonRpcProvider(`http://127.0.0.1:${port}`);
  provider.pollingInterval = opts.blockTime ? 100 : 20;
  return { server, provider };
}

/** Nonce-managed sender; `exec` waits for the receipt, `fire` only submits. */
class Sender {
  constructor(wallet, { gasPrice = ethers.utils.parseUnits("1", "gwei"), chainId = 1337 } = {}) {
    this.w = wallet;
    this.nonce = null;
    this.gasPrice = gasPrice;
    this.chainId = chainId;
  }
  async fire(contract, method, args, gasLimit = 600000) {
    if (this.nonce === null) this.nonce = await this.w.getTransactionCount("pending");
    const data = contract.interface.encodeFunctionData(method, args);
    return this.w.sendTransaction({ to: contract.address, data, gasLimit, gasPrice: this.gasPrice, nonce: this.nonce++, chainId: this.chainId, type: 0 });
  }
  async exec(contract, method, args, gasLimit) {
    const t0 = process.hrtime.bigint();
    const tx = await this.fire(contract, method, args, gasLimit);
    let rc;
    try {
      rc = await tx.wait();
    } catch (e) {
      rc = e.receipt;
    }
    return { rc, latency: Number(process.hrtime.bigint() - t0) / 1e6, ok: Boolean(rc && rc.status === 1), gas: rc ? rc.gasUsed.toNumber() : null };
  }
}

const ms = (t0) => Number(process.hrtime.bigint() - t0) / 1e6;
const now = () => process.hrtime.bigint();
const sleep = (t) => new Promise((r) => setTimeout(r, t));

module.exports = { OUT, rng, stats, writeCsv, mergeSummary, buildWorkload, startGanache, Sender, ms, now, sleep };
