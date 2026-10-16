"""Figure 1: PCTF layered architecture (black and white, 600 dpi)."""
import sys
from diagram_lib import *

out = sys.argv[1] if len(sys.argv) > 1 else "fig1_architecture"
fig, ax = canvas(16.5, 11.6, 100, 70)

# lanes
lane(ax, 1, 55.6, 98.6, 11.2, "Stakeholders")
lane(ax, 1, 32.6, 98.6, 22.4, "PCTF client and\nservice layer")
lane(ax, 1, 19.2, 98.6, 12.8, "Off-chain\nstorage")
lane(ax, 1, 1.2, 98.6, 17.4, "On-chain (EVM)")

# stakeholders
S = [
    ("Administrator", "governance, onboarding", icon_gear, 10.5),
    ("Hotel", "venue check-ins", icon_hotel, 27.9),
    ("Health Authority", "diagnosis, exposure", icon_health, 45.3),
    ("Tourism Authority", "aggregate analytics", icon_chart, 62.7),
    ("Tourist", "wallet + mobile app", icon_person, 80.1),
]
for name, sub, ico, x in S:
    box(ax, x, 57.2, 14.6, 8.0, None, (), fill="white")
    ico(ax, x + 2.4, 61.2, 0.95)
    ax.text(x + 8.9, 62.3, name, ha="center", va="center", fontsize=5.5, fontweight="bold")
    ax.text(x + 8.9, 59.9, sub, ha="center", va="center", fontsize=4.6)

# transaction bus (top, then down the left channel)
ax.add_line(Line2D([9.3, 87.4], [68.0, 68.0], color=K, lw=1.0))
for _, _, _, x in S:
    ax.add_line(Line2D([x + 7.3, x + 7.3], [65.2, 68.0], color=K, lw=1.0))
    ax.add_patch(Circle((x + 7.3, 68.0), 0.35, fc=K, ec=K, zorder=6))
arrow(ax, [(9.3, 68.0), (9.3, 11.0), (10.6, 11.0)], lw=1.0)
arrow(ax, [(9.3, 11.0), (9.3, 2.3), (79.0, 2.3), (79.0, 4.0)], lw=1.0, head=True)
ax.text(54.0, 69.2, "signed transactions from each wallet (Algorithms 1-3): registerParticipant, createVenueRecord, recordDiagnosis, notifyExposures, setConsent",
        ha="center", va="center", fontsize=5.2, style="italic")

# gateway + modules
box(ax, 10.5, 48.6, 85.2, 4.4, "PCTF REST gateway", ("requests authenticated by EIP-191 signed challenges (timestamp + nonce); no private key is ever sent",), title_size=6.4, body_size=5.3)
for _, _, _, x in S:
    arrow(ax, [(x + 9.3, 57.2), (x + 9.3, 53.0)], lw=0.7)

M = [
    (10.5, 15.0, "Pseudonym service", ["HMAC-SHA256, secret pepper", "subject pseudonym per day", "venue pseudonym"]),
    (27.8, 15.0, "Envelope encryption", ["AES-256-GCM, 96-bit nonce", "fresh data key (DEK) per record", "SHA-256 content digest"]),
    (45.1, 17.4, "Key-release service", ["Algorithm 4: verify signature,", "evaluate on-chain policy as the", "requester, check consent / expiry,", "unwrap DEK, decrypt"]),
    (64.8, 14.6, "Exposure matcher", ["Algorithm 3: uses window", "pseudonyms (HA only) and", "venue-overlap scan"]),
    (81.7, 14.0, "Audit log", ["hash-chained entries", "GRANT / DENY / SHRED", "head can be anchored"]),
]
for x, w, t, ls in M:
    box(ax, x, 35.2, w, 11.2, t, ls, title_size=5.8, body_size=4.5)

arrow(ax, [(42.8, 41.0), (45.1, 41.0)], lw=0.7)
ax.text(43.95, 42.4, "DEK", ha="center", fontsize=4.8)
arrow(ax, [(62.5, 40.2), (64.8, 40.2)], lw=0.7)
arrow(ax, [(58.0, 46.4), (58.0, 47.5), (88.7, 47.5), (88.7, 46.4)], lw=0.6)
ax.text(73.3, 47.5, "decisions", ha="center", va="center", fontsize=4.8, bbox=dict(fc="#f2f2f2", ec="none", pad=0.3))

# off-chain storage
box(ax, 10.5, 21.0, 31.0, 9.4, None, ())
icon_db(ax, 14.5, 25.7, 1.25)
ax.text(28.5, 28.0, "Content-addressed object store", ha="center", fontsize=6.2, fontweight="bold")
ax.text(28.5, 25.6, "ciphertext E stored under SHA-256(E)", ha="center", fontsize=5.0)
ax.text(28.5, 23.5, "local store or IPFS CIDv1 (raw, sha2-256)", ha="center", fontsize=5.0)
box(ax, 44.4, 21.0, 24.0, 9.4, None, ())
icon_key(ax, 47.6, 25.7, 1.2)
ax.text(58.2, 28.0, "Key store", ha="center", fontsize=6.2, fontweight="bold")
ax.text(58.2, 25.6, "DEK wrapped under KEK, per digest", ha="center", fontsize=5.0)
ax.text(58.2, 23.5, "delete entry = crypto-shredding", ha="center", fontsize=5.0)
box(ax, 72.4, 21.0, 23.3, 9.4, "Retention and consent", ["purge keys after TTL;", "shred all keys of a tourist", "on ConsentChanged(false)"], title_size=6.0, body_size=5.0)
arrow(ax, [(72.4, 25.7), (68.4, 25.7)], lw=0.7)

arrow(ax, [(35.3, 35.2), (35.3, 30.4)], lw=0.7)
ax.text(34.6, 32.9, "put E", ha="right", va="center", fontsize=4.6)
arrow(ax, [(48.0, 35.2), (48.0, 33.4), (39.5, 33.4), (39.5, 30.4)], lw=0.7, style="--")
ax.text(43.8, 34.3, "get E, verify", ha="center", fontsize=4.6, bbox=dict(fc="#f2f2f2", ec="none", pad=0.2))
arrow(ax, [(55.0, 35.2), (55.0, 30.4)], lw=0.7, both=True)
ax.text(56.0, 32.8, "wrap /\nunwrap", ha="left", va="center", fontsize=4.6)

# read-only policy channel
ax.add_line(Line2D([61.5, 61.5, 70.4], [35.2, 32.3, 32.3], color=K, lw=0.7, ls="--"))
ax.add_line(Line2D([72.0, 72.0, 70.4], [35.2, 32.3, 32.3], color=K, lw=0.7, ls="--"))
arrow(ax, [(70.4, 32.3), (70.4, 16.0)], lw=0.7, style="--")
ax.text(70.9, 17.2, "read-only eth_call, from = authenticated requester", ha="left", va="center", fontsize=4.9, bbox=dict(fc="white", ec="none", pad=0.3))

# on-chain contracts
box(ax, 10.5, 4.0, 24.0, 12.0, None, ())
ax.text(22.5, 13.6, "ParticipantRegistry", ha="center", fontsize=6.2, fontweight="bold")
for i, t in enumerate(["φ : PK → R (one role per wallet)", "register / updateRole / revoke", "admin-only; last admin protected"]):
    ax.text(22.5, 11.0 - 2.1 * i, t, ha="center", fontsize=5.0)
box(ax, 37.5, 4.0, 24.0, 12.0, None, ())
ax.text(49.5, 13.6, "RoleAccessControl", ha="center", fontsize=6.2, fontweight="bold")
for i, t in enumerate(["ρ : R × D × A → {0,1} as 64-bit matrix", "δ(pk,d,a) enforced on every write", "setPolicy logged (d_c, WRITE)"]):
    ax.text(49.5, 11.0 - 2.1 * i, t, ha="center", fontsize=5.0)
box(ax, 64.5, 4.0, 31.2, 12.0, None, ())
icon_chain(ax, 69.0, 13.6, 1.1)
ax.text(82.0, 13.6, "ContactRecordManager", ha="center", fontsize=6.2, fontweight="bold")
for i, t in enumerate(["pseudonyms + content digest + times only", "venue records, diagnoses, exposure notices,", "aggregates, consent; bounded loops (≤100)"]):
    ax.text(80.1, 11.0 - 2.1 * i, t, ha="center", fontsize=5.0)
arrow(ax, [(37.5, 10.0), (34.5, 10.0)], lw=0.7)
ax.text(36.0, 7.2, "roleOf", ha="center", fontsize=4.6)
arrow(ax, [(64.5, 10.0), (61.5, 10.0)], lw=0.7)
ax.text(63.0, 7.2, "inherits", ha="center", fontsize=4.6)

# feedback: exposure notices back to tourists
arrow(ax, [(95.7, 12.0), (98.0, 12.0), (98.0, 61.2), (94.7, 61.2)], lw=0.9, style=(0, (1, 1.2)))
ax.text(98.0, 40.0, "exposure notices (events / getExposure)", rotation=90, ha="center", va="center", fontsize=4.6, bbox=dict(fc="#f2f2f2", ec="none", pad=0.25))

# legend
lx, ly = 11.0, 0.0
save(fig, out)
print("saved", out)
