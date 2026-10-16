"""Result figures (B&W, 600 dpi) generated from results/*.csv and results/summary.json.
Usage: python3 scripts/figures/fig_results.py <results_dir> <out_dir>
"""
import csv
import json
import os
import sys

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

plt.rcParams.update({
    "font.family": "Liberation Sans", "font.size": 7, "axes.linewidth": 0.6, "xtick.major.width": 0.6,
    "ytick.major.width": 0.6, "xtick.direction": "in", "ytick.direction": "in", "legend.frameon": False, "hatch.linewidth": 0.5,
})
R = sys.argv[1] if len(sys.argv) > 1 else "results"
O = sys.argv[2] if len(sys.argv) > 2 else "figures"
os.makedirs(O, exist_ok=True)
S = json.load(open(os.path.join(R, "summary.json")))


def rows(name):
    return list(csv.DictReader(open(os.path.join(R, name))))


def save(fig, name):
    fig.savefig(os.path.join(O, name + ".png"), dpi=600)
    fig.savefig(os.path.join(O, name + ".pdf"))
    plt.close(fig)


# ------------------------------------------------ Figure 3: hybrid vs fully on-chain
sizes = [256, 512, 1024, 2048, 4096]
bs = S["E3"]["bySize"]
full = [bs[str(s)]["fullGas"] / 1000 for s in sizes]
hyb = [bs[str(s)]["hybridGas"] / 1000 for s in sizes]
fsl = [bs[str(s)]["fullNewSlots"] * 32 for s in sizes]
hsl = [bs[str(s)]["hybridNewSlots"] * 32 for s in sizes]
fig, axs = plt.subplots(1, 2, figsize=(16.0 / 2.54, 5.6 / 2.54))
x = np.arange(len(sizes))
w = 0.38
ax = axs[0]
b1 = ax.bar(x - w / 2, full, w, color="white", edgecolor="black", hatch="////", lw=0.6, label="Fully on-chain baseline")
b2 = ax.bar(x + w / 2, hyb, w, color="black", edgecolor="black", lw=0.6, label="PCTF hybrid")
for i, s in enumerate(sizes):
    ax.text(x[i] - w / 2, full[i] + 40, f"{full[i]:.0f}", ha="center", va="bottom", fontsize=5.2)
    ax.text(x[i] + w / 2, hyb[i] + 40, f"{hyb[i]:.0f}", ha="center", va="bottom", fontsize=5.2)
ax.set_xticks(x, [str(s) for s in sizes])
ax.set_xlabel("Encrypted payload size (bytes)")
ax.set_ylabel("Gas per record (×10$^3$)")
ax.set_ylim(0, max(full) * 1.15)
ax.legend(loc="upper left", fontsize=6)
ax.set_title("(a) Gas per record creation", fontsize=7)
ax = axs[1]
ax.plot(sizes, fsl, "s-", color="black", mfc="white", ms=3.5, lw=0.8, label="Fully on-chain baseline")
ax.plot(sizes, hsl, "o-", color="black", ms=3.5, lw=0.8, label="PCTF hybrid")
ax.plot(sizes, sizes, ":", color="black", lw=0.7, label="payload size (reference)")
ax.set_xscale("log", base=2)
ax.set_xticks(sizes, [str(s) for s in sizes])
ax.set_xlabel("Encrypted payload size (bytes)")
ax.set_ylabel("New contract storage (bytes)")
ax.legend(loc="upper left", fontsize=6)
ax.set_title("(b) New on-chain state per record", fontsize=7)
for a in axs:
    a.spines["top"].set_visible(False)
    a.spines["right"].set_visible(False)
fig.tight_layout(pad=0.4, w_pad=1.6)
save(fig, "fig3_hybrid_vs_onchain")

# ------------------------------------------------ Figure 4: throughput with 2 s blocks
rr = rows("e4_throughput_2s.csv")
lat = np.sort([float(r["latencyMs"]) / 1000 for r in rr])
fig, axs = plt.subplots(1, 2, figsize=(16.0 / 2.54, 5.2 / 2.54))
ax = axs[0]
ax.plot(lat, np.arange(1, len(lat) + 1) / len(lat), "-", color="black", lw=0.9)
ax.axvline(np.median(lat), color="black", lw=0.6, ls=":")
ax.text(np.median(lat), 0.08, f"  median {np.median(lat):.1f} s", fontsize=6, ha="left")
ax.set_xlabel("Submission-to-inclusion latency (s)")
ax.set_ylabel("Cumulative fraction of records")
ax.set_ylim(0, 1.02)
ax.set_title("(a) Inclusion latency, 1500 records", fontsize=7)
ax = axs[1]
blocks = {}
for r in rr:
    blocks[int(r["block"])] = blocks.get(int(r["block"]), 0) + 1
ks = sorted(blocks)
cum = np.cumsum([blocks[k] for k in ks])
idx = np.arange(1, len(ks) + 1)
ax.step(idx, cum, where="post", color="black", lw=0.9, label="measured (≤100 in flight)")
cap = 30e6 / np.mean([float(r["gasUsed"]) for r in rr])
ax.plot(idx, cap * idx, "--", color="black", lw=0.7, label=f"gas-limit bound ({cap:.0f}/block)")
ax.set_xlabel("Blocks since first submission")
ax.set_ylabel("Records confirmed (cumulative)")
ax.legend(loc="upper left", fontsize=6)
ax.set_title("(b) Confirmed records per block", fontsize=7)
for a_ in axs:
    a_.spines["top"].set_visible(False)
    a_.spines["right"].set_visible(False)
fig.tight_layout(pad=0.4, w_pad=1.6)
save(fig, "fig4_throughput")

# ------------------------------------------------ Figure 5: gas per operation
ops = [
    ("registerParticipant", S["E1"]["gas"]["mean"], S["E1"]["gas"]["sd"], "w"),
    ("setConsent", S["E1"]["consentGas"]["mean"], S["E1"]["consentGas"]["sd"], "w"),
    ("createVenueRecord", S["E2"]["gas"]["mean"], S["E2"]["gas"]["sd"], "w"),
    ("recordDiagnosis", S["E5"]["diagnosisGas"]["mean"], S["E5"]["diagnosisGas"]["sd"], "w"),
    ("notifyExposures (per notice)", S["E5"]["notifyGasPerNotice"]["mean"], S["E5"]["notifyGasPerNotice"]["sd"], "w"),
    ("publishAggregate", S["E5"]["aggregateGas"]["mean"], S["E5"]["aggregateGas"]["sd"], "w"),
    ("denied write (reverted)", S["E6"]["revertedTxGas"]["mean"], S["E6"]["revertedTxGas"]["sd"], "r"),
    ("createVenueRecordFull (baseline)", S["E3"]["workload"]["fullGas"], 0, "b"),
]
fig, ax = plt.subplots(figsize=(16.0 / 2.54, 5.0 / 2.54))
y = np.arange(len(ops))[::-1]
for yi, (name, m, sd, kind) in zip(y, ops):
    ax.barh(yi, m / 1000, 0.6, color={"w": "black", "r": "white", "b": "white"}[kind], edgecolor="black", hatch={"w": None, "r": "....", "b": "////"}[kind], lw=0.6, xerr=sd / 1000 if sd else None, error_kw=dict(lw=0.6, capsize=1.5, ecolor="black"))
    ax.text(m / 1000 + (sd / 1000 if sd else 0) + 8, yi, f"{m:,.0f}", va="center", fontsize=5.6)
ax.set_yticks(y, [o[0] for o in ops], fontsize=6)
ax.set_xlabel("Gas used (×10$^3$), mean ± SD")
ax.set_xlim(0, S["E3"]["workload"]["fullGas"] / 1000 * 1.18)
ax.spines["top"].set_visible(False)
ax.spines["right"].set_visible(False)
fig.tight_layout(pad=0.4)
save(fig, "fig5_gas_per_operation")
print("figures written to", O)
