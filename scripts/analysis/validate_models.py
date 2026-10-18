"""Analytical models and statistical bounds used in the paper (Sections 6.1-6.4).

1. Gas cost model. The fully on-chain baseline writes the ciphertext into new storage
   words, so its cost should grow by about G_sset/32 + G_calldata per byte
   (22,100/32 + 16 = 706.6 gas/byte under the Shanghai schedule), while PCTF stores a
   32-byte digest and its cost should not depend on payload size. Both models are
   fitted by ordinary least squares on every measured record.
2. Throughput bound lambda_max = floor(G_block / g) / T_block.
3. Exact (Clopper-Pearson) 95% bounds for the matching and access-control results,
   and a t-interval for the mean matching time.
Usage: python3 scripts/analysis/validate_models.py [results_dir]
"""
import csv
import json
import math
import os
import sys

import numpy as np
from scipy import stats

R = sys.argv[1] if len(sys.argv) > 1 else "results"
S = json.load(open(os.path.join(R, "summary.json")))


def rows(name):
    return list(csv.DictReader(open(os.path.join(R, name))))


def ols(x, y):
    x, y = np.asarray(x, float), np.asarray(y, float)
    res = stats.linregress(x, y)
    n = len(x)
    tcrit = stats.t.ppf(0.975, n - 2)
    return {
        "n": n, "intercept": res.intercept, "slope": res.slope,
        "slope_ci95": [res.slope - tcrit * res.stderr, res.slope + tcrit * res.stderr],
        "intercept_ci95": [res.intercept - tcrit * res.intercept_stderr, res.intercept + tcrit * res.intercept_stderr],
        "r2": res.rvalue ** 2,
    }


out = {}
# ---------------------------------------------------------------- 1. gas model
G_SSET_COLD, G_CALLDATA = 22100, 16
out["predictedSlopeGasPerByte"] = G_SSET_COLD / 32 + G_CALLDATA
sz = rows("e3_baseline_sizes.csv")
wl = rows("e3_baseline_workload.csv")
fx = [int(r["payloadBytes"]) for r in sz if r["design"] == "full-on-chain"] + [int(r["ciphertextBytes"]) for r in wl]
fy = [int(r["gasUsed"]) for r in sz if r["design"] == "full-on-chain"] + [int(r["fullGas"]) for r in wl]
hx = [int(r["payloadBytes"]) for r in sz if r["design"] == "PCTF-hybrid"] + [int(r["ciphertextBytes"]) for r in wl]
hy = [int(r["gasUsed"]) for r in sz if r["design"] == "PCTF-hybrid"] + [int(r["hybridGas"]) for r in wl]
full, hyb = ols(fx, fy), ols(hx, hy)
out["fullOnChainFit"], out["hybridFit"] = full, hyb
# fit on the controlled size sweep only (payloads 256-4096 B)
out["fullOnChainFitSweep"] = ols([int(r["payloadBytes"]) for r in sz if r["design"] == "full-on-chain"],
                                 [int(r["gasUsed"]) for r in sz if r["design"] == "full-on-chain"])
gh = float(np.mean(hy))
out["hybridMeanGas"] = gh
out["hybridSdGas"] = float(np.std(hy, ddof=1))
# break-even size where the baseline becomes more expensive than PCTF
out["breakEvenBytes"] = (gh - full["intercept"]) / full["slope"]
pred = {L: 1 - gh / (full["intercept"] + full["slope"] * L) for L in (256, 512, 1024, 2048, 4096)}
meas = {L: S["E3"]["bySize"][str(L)]["gasSavingPct"] / 100 for L in pred}
out["savingModelVsMeasured"] = {str(L): {"model": round(pred[L], 4), "measured": meas[L]} for L in pred}
out["savingMaxAbsError"] = max(abs(pred[L] - meas[L]) for L in pred)
# storage words: 8 + L/32 new slots for the baseline (traced records with L >= 512)
out["baselineSlotsCheck"] = {str(L): {"traced": S["E3"]["bySize"][str(L)]["fullNewSlots"], "model": 8 + L // 32} for L in (512, 1024, 2048, 4096)}

# ---------------------------------------------------------------- 2. throughput bound
G_BLOCK = 30_000_000
g_tp = S["E4"]["blockTime2s"]["gas"]["mean"]
g_wl = S["E2"]["gas"]["mean"]
out["throughputBound"] = {
    "gasPerRecordThroughputRun": g_tp, "recordsPerBlockThroughputRun": math.floor(G_BLOCK / g_tp),
    "gasPerRecordWorkload": g_wl, "recordsPerBlockWorkload": math.floor(G_BLOCK / g_wl),
}
for T in (2, 12):
    out["throughputBound"][f"lambdaMax_{T}s_throughputRun"] = math.floor(G_BLOCK / g_tp) / T
    out["throughputBound"][f"lambdaMax_{T}s_workload"] = math.floor(G_BLOCK / g_wl) / T


# ---------------------------------------------------------------- 3. exact bounds
def clopper_pearson(k, n, a=0.05):
    lo = 0.0 if k == 0 else stats.beta.ppf(a / 2, k, n - k + 1)
    hi = 1.0 if k == n else stats.beta.ppf(1 - a / 2, k + 1, n - k)
    return [lo, hi]


E5, E6 = S["E5"], S["E6"]
out["recallCI95"] = clopper_pearson(E5["truePositives"], E5["groundTruthExposedPseudonyms"])
out["precisionCI95"] = clopper_pearson(E5["truePositives"], E5["truePositives"] + E5["falsePositives"])
out["falseAlertRateCI95"] = clopper_pearson(E5["falseAlerts"], E5["negativeTouristsChecked"])
out["accessMatrixCI95"] = clopper_pearson(E6["matches"], E6["cases"])
mt = [float(r["matchMs"]) for r in rows("e5_diagnosis_matching.csv")]
m, s, n = np.mean(mt), np.std(mt, ddof=1), len(mt)
h = stats.t.ppf(0.975, n - 1) * s / math.sqrt(n)
out["matchMsMeanCI95"] = [m, m - h, m + h]

# ---------------------------------------------------------------- 4. anonymity sets
an = rows("e10_anonymity_sets.csv") if os.path.exists(os.path.join(R, "e10_anonymity_sets.csv")) else []
if an:
    k = np.array([int(r["subjects"]) for r in an])
    out["anonymitySetsPerCell"] = {"cells": len(k), "median": float(np.median(k)), "min": int(k.min()), "max": int(k.max())}


def clean(o):
    if isinstance(o, dict):
        return {k: clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [clean(v) for v in o]
    if isinstance(o, (np.floating, float)):
        return round(float(o), 6)
    if isinstance(o, np.integer):
        return int(o)
    return o


json.dump(clean(out), open(os.path.join(R, "e11_models.json"), "w"), indent=2)
print(json.dumps(clean(out), indent=1))
