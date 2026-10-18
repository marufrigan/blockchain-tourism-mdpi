/**
 * Anonymity sets of the on-chain venue index (Section 4, Theorem 2).
 * Rebuilds the evaluation workload with the same seed and generator as
 * scripts/experiments/run-all.js and counts, for every (venue, check-in epoch),
 * how many distinct subjects checked in. An observer of public chain state sees
 * one record per stay under (venue pseudonym, epoch); the count is the anonymity
 * set of a single record against an observer who knows the venue and the day.
 * Usage: node scripts/analysis/anonymity.js [results_dir]
 */
const fs = require("fs");
const path = require("path");

const CFG = { seed: 20260302, tourists: 950, hotels: 30, days: 14, T0: 1772409600 };
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

// Same draw order as buildWorkload() in run-all.js, so the stays are identical.
function buildWorkload() {
  const areas = ["lobby", "restaurant", "lift", "gym", "pool", "bar", "spa", "conference"];
  const stays = [];
  for (let ti = 0; ti < CFG.tourists; ti++) {
    const n = ri(1, 3);
    for (let k = 0; k < n; k++) {
      const v = ri(0, CFG.hotels - 1);
      const day = ri(0, CFG.days - 2);
      const tStart = CFG.T0 + day * 86400 + ri(12, 22) * 3600 + ri(0, 59) * 60;
      const tEnd = tStart + ri(1, 3) * 86400 - ri(1, 6) * 3600;
      Array.from({ length: ri(2, 12) }, () => ({ area: pick(areas), at: ri(tStart, tEnd) }));
      ri(100, 899); // room
      ri(1, 4); // party size
      stays.push({ tourist: ti, venue: v, tStart, tEnd });
    }
  }
  return stays;
}

const out = process.argv[2] || "results";
const stays = buildWorkload();
const cells = new Map();
for (const s of stays) {
  const key = `${s.venue}:${Math.floor(s.tStart / 86400)}`;
  if (!cells.has(key)) cells.set(key, new Set());
  cells.get(key).add(s.tourist);
}
const rows = [...cells.entries()].map(([k, set]) => {
  const [venue, epoch] = k.split(":");
  return { venue: Number(venue), epoch: Number(epoch), subjects: set.size };
});
rows.sort((a, b) => a.venue - b.venue || a.epoch - b.epoch);
fs.writeFileSync(path.join(out, "e10_anonymity_sets.csv"), ["venue,epoch,subjects", ...rows.map((r) => `${r.venue},${r.epoch},${r.subjects}`)].join("\n"));
const maxStay = Math.max(...stays.map((s) => s.tEnd - s.tStart));
const perRecord = stays.map((s) => cells.get(`${s.venue}:${Math.floor(s.tStart / 86400)}`).size).sort((a, b) => a - b);
const q = (p) => perRecord[Math.floor(p * (perRecord.length - 1))];
console.log(JSON.stringify({ stays: stays.length, cells: rows.length, maxStaySec: maxStay, perRecordK: { min: perRecord[0], p10: q(0.1), median: q(0.5), max: perRecord[perRecord.length - 1], uniqueRecords: perRecord.filter((k) => k === 1).length } }));
