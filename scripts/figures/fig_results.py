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
# measured mean +/- SD per size, with the least-squares cost models of Section 6.2
M = json.load(open(os.path.join(R, "e11_models.json")))
fit, hfit = M["fullOnChainFitSweep"], M["hybridMeanGas"]
sz_rows = rows("e3_baseline_sizes.csv")
def ms_of(design):
    m_, s_ = [], []
    for L in sizes:
        g = [float(r["gasUsed"]) / 1000 for r in sz_rows if r["design"] == design and int(r["payloadBytes"]) == L]
        m_.append(np.mean(g)); s_.append(np.std(g, ddof=1))
    return m_, s_
fm, fsd = ms_of("full-on-chain")
hm, hsd = ms_of("PCTF-hybrid")
Ls = np.linspace(200, 4300, 200)
ax.plot(Ls, (fit["intercept"] + fit["slope"] * Ls) / 1000, "-", color="black", lw=0.7,
        label=f"model $G_{{full}}$ = {fit['intercept']/1000:.1f}k + {fit['slope']:.1f}$L$ ($R^2$={fit['r2']:.5f})")
ax.plot(Ls, np.full_like(Ls, hfit / 1000), "--", color="black", lw=0.7, label=f"model $G_{{PCTF}}$ = {hfit/1000:.1f}k (constant)")
ax.errorbar(sizes, fm, yerr=fsd, fmt="s", color="black", mfc="white", ms=3.5, lw=0.6, capsize=1.5, label="Fully on-chain baseline (measured)")
ax.errorbar(sizes, hm, yerr=hsd, fmt="o", color="black", ms=3.5, lw=0.6, capsize=1.5, label="PCTF hybrid (measured)")
ax.set_xscale("log", base=2)
ax.set_xticks(sizes, [str(s) for s in sizes])
ax.set_xlabel("Encrypted payload size $L$ (bytes)")
ax.set_ylabel("Gas per record (×10$^3$)")
ax.set_ylim(0, max(fm) * 1.12)
ax.legend(loc="upper left", fontsize=5.4)
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

# ------------------------------------------------ Figure 4: inclusion latency (Ganache vs Besu QBFT) and revocation delay
def cdf(ax, v, style, label):
    v = np.sort(v)
    ax.plot(v, np.arange(1, len(v) + 1) / len(v), style, color="black", lw=0.9, label=label)
fig, axs = plt.subplots(1, 2, figsize=(16.0 / 2.54, 5.2 / 2.54))
ax = axs[0]
g = [float(r["latencyMs"]) / 1000 for r in rows("e4_throughput_2s.csv")]
b_ = [float(r["latencyMs"]) / 1000 for r in rows("e15_throughput.csv")]
cdf(ax, g, "--", f"Ganache, 1 node (median {np.median(g):.1f} s)")
cdf(ax, b_, "-", f"Besu QBFT, 4 validators (median {np.median(b_):.1f} s)")
ax.set_xlabel("Submission-to-inclusion latency (s)")
ax.set_ylabel("Cumulative fraction of records")
ax.set_ylim(0, 1.02)
ax.set_xlim(left=0)
ax.legend(loc="lower right", fontsize=5.8)
ax.set_title("(a) Inclusion latency, 1,500 records, 2 s block period", fontsize=7)
ax = axs[1]
rv = rows("e19_revocation_delay.csv")
for kind, style in [("role revocation", "-"), ("consent withdrawal", "--"), ("policy change", ":")]:
    v = [float(r["enforcementMs"]) / 1000 for r in rv if r["kind"] == kind and r["enforcementMs"]]
    if v:
        cdf(ax, v, style, f"{kind} (n={len(v)}, median {np.median(v):.2f} s)")
ax.set_xlabel("Change submitted to first denied release (s)")
ax.set_ylabel("Cumulative fraction of trials")
ax.set_ylim(0, 1.02)
ax.set_xlim(1.6, 2.1)
ax.axvline(2.0, color="black", lw=0.5, ls=(0, (1, 2)))
ax.text(2.0, 0.03, " block period", fontsize=5.6, ha="left")
ax.legend(loc="upper left", fontsize=5.8)
ax.set_title("(b) Revocation-to-enforcement delay, Besu QBFT", fontsize=7)
for a_ in axs:
    a_.spines["top"].set_visible(False)
    a_.spines["right"].set_visible(False)
fig.tight_layout(pad=0.4, w_pad=1.6)
save(fig, "fig4_latency_revocation")

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
