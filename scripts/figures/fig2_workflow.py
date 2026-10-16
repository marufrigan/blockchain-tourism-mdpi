"""Figure 2: PCTF end-to-end workflow as a swimlane sequence diagram (B&W, 600 dpi)."""
import sys
from diagram_lib import *

out = sys.argv[1] if len(sys.argv) > 1 else "fig2_workflow"
fig, ax = canvas(16.5, 15.6, 100, 96)

L = ["Administrator", "Tourist", "Hotel", "Health\nAuthority", "Key-release\nservice", "Off-chain\nstore", "Smart\ncontracts"]
ICON = [icon_gear, icon_person, icon_hotel, icon_health, icon_key, icon_db, icon_chain]
x0, x1 = 9.0, 99.4
lw_ = (x1 - x0) / len(L)
X = [x0 + lw_ * (i + 0.5) for i in range(len(L))]
top = 86.6

# phase bands
P = [
    ("1  Onboarding\n(Alg. 1)", 83.4, 71.0),
    ("2  Check-in\n(Alg. 2)", 71.0, 54.4),
    ("3  Diagnosis and\nexposure (Alg. 3)", 54.4, 32.0),
    ("4  Retrieval\n(Alg. 4)", 32.0, 17.6),
    ("5  Notification\nand consent", 17.6, 1.0),
]
for i, (name, ya, yb) in enumerate(P):
    ax.add_patch(Rectangle((1.0, yb), x1 - 1.0, ya - yb, fc="#f4f4f4" if i % 2 == 0 else "white", ec=K, lw=0.5, zorder=0))
    ax.add_patch(Rectangle((1.0, yb), 7.6, ya - yb, fc="#d9d9d9", ec=K, lw=0.5, zorder=0))
    ax.text(4.8, (ya + yb) / 2, name, rotation=90, ha="center", va="center", fontsize=5.6, fontweight="bold")

# lane headers and lifelines
for i, (name, xx) in enumerate(zip(L, X)):
    box(ax, xx - lw_ / 2 + 0.6, top, lw_ - 1.2, 8.0, None, ())
    ICON[i](ax, xx, top + 5.3, 0.85)
    ax.text(xx, top + 2.0, name, ha="center", va="center", fontsize=5.4, fontweight="bold", linespacing=0.95)
    ax.add_line(Line2D([xx, xx], [top, 1.0], color=K, lw=0.5, ls=(0, (3, 2)), zorder=1))

A = dict(zip(["ad", "to", "ho", "ha", "kr", "st", "sc"], X))
n = [0]


def msg(a, b, y, text, style="-", ret=False, alg=None):
    n[0] += 1
    xa, xb = A[a], A[b]
    d = 1 if xb > xa else -1
    arrow(ax, [(xa + 0.5 * d, y), (xb - 0.5 * d, y)], style="--" if ret else style, lw=0.75)
    badge(ax, xa - 1.5 * d, y, str(n[0]), r=0.95, size=4.6)
    tx = (xa + xb) / 2
    ax.text(tx, y + 1.25, text, ha="center", va="center", fontsize=4.8, bbox=dict(fc="white", ec="none", pad=0.25), zorder=6)


def note(lanekey, y, text, w=12.0, h=3.6, dx=0.0):
    xx = A[lanekey] + dx
    box(ax, xx - w / 2, y - h / 2, w, h, None, (), round_=0.3, lw=0.6, fill="white", dash=(0, (2, 1.2)))
    ax.text(xx, y, text, ha="center", va="center", fontsize=4.5, linespacing=0.95, zorder=7)


def act(lanekey, y0, y1):
    xx = A[lanekey]
    ax.add_patch(Rectangle((xx - 0.45, y1), 0.9, y0 - y1, fc="white", ec=K, lw=0.6, zorder=3))


# Phase 1
msg("ad", "sc", 79.6, "registerParticipant(pk, r)")
msg("ad", "kr", 76.4, "enrol tourist: wallet \u2194 subject ID (off-chain)", style=":")
msg("to", "sc", 73.2, "setConsent(true)")
# Phase 2
act("kr", 68.6, 60.2)
msg("ho", "kr", 68.0, "prepare check-in (signed)")
note("kr", 64.5, "HMAC pseudonyms; AES-256-GCM\nwith new DEK; wrap DEK", w=17.0, h=3.6, dx=-9.6)
msg("kr", "st", 61.0, "put E (key = SHA-256(E))")
msg("kr", "ho", 58.2, "subjectHash, venueHash, digest", ret=True)
msg("ho", "sc", 55.6, "createVenueRecord(sp, vp, digest, t_in, t_out, ttl)")
# Phase 3
msg("ha", "sc", 51.2, "recordDiagnosis(sp, digest, t_d, w)")
msg("ha", "kr", 48.0, "window pseudonyms? (signed)")
msg("kr", "ha", 45.0, "pseudonyms of [t_d\u2212w\u2212stay, t_d]", ret=True)
msg("ha", "sc", 41.8, "getSubjectRecordIds / getVenueRecordIds / getRecord (views)", style="--")
note("ha", 38.2, "overlap match on venue and interval", w=17.0, h=2.6, dx=-6.0)
msg("ha", "sc", 34.6, "notifyExposures(id, \u2264100 pseudonyms)")
# Phase 4
act("kr", 30.0, 19.8)
msg("ha", "kr", 29.4, "release(id), signed")
msg("kr", "sc", 26.4, "eth_call getRecord, from = requester (\u03c1 check)", style="--")
msg("kr", "st", 23.4, "get E, verify digest")
msg("kr", "ha", 20.4, "payload; audit GRANT", ret=True)
# Phase 5
msg("to", "kr", 15.0, "own pseudonyms (signed)")
msg("to", "sc", 11.8, "getExposure(p) \u2192 diagnosis id or 0", style="--")
msg("to", "sc", 8.6, "setConsent(false)")
msg("sc", "kr", 5.4, "ConsentChanged event", style=":")
note("kr", 2.6, "shred all DEKs of that tourist", w=17.0, h=2.4, dx=-6.0)

# legend
lg = [("-", "transaction / request"), ("--", "read (eth_call) / reply"), (":", "off-chain or event")]
for i, (st, t) in enumerate(lg):
    yy = 89.0 - i * 2.2
    pass

save(fig, out)
print("saved", out)
