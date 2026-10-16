"""Small helper library for black-and-white technical diagrams (IEEE style)."""
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, Rectangle, Circle, Polygon, FancyArrowPatch, Wedge
from matplotlib.lines import Line2D

FONT = "Liberation Sans"
plt.rcParams.update({"font.family": FONT, "font.size": 7, "axes.linewidth": 0.6, "hatch.linewidth": 0.4})

K = "black"


def canvas(w_cm, h_cm, xmax=100, ymax=60):
    fig = plt.figure(figsize=(w_cm / 2.54, h_cm / 2.54))
    ax = fig.add_axes([0, 0, 1, 1])
    ax.set_xlim(0, xmax)
    ax.set_ylim(0, ymax)
    ax.axis("off")
    return fig, ax


def box(ax, x, y, w, h, title=None, lines=(), lw=0.8, fill="white", hatch=None, round_=0.6, title_size=7, body_size=5.8, dash=None, bold=True):
    p = FancyBboxPatch((x, y), w, h, boxstyle=f"round,pad=0,rounding_size={round_}", lw=lw, ec=K, fc=fill, hatch=hatch, ls=dash or "-")
    ax.add_patch(p)
    n = len(lines) + (1 if title else 0)
    if n:
        step = min(2.3, (h - 1.0) / max(n, 1))
        y0 = y + h / 2 + step * (n - 1) / 2
        i = 0
        if title:
            ax.text(x + w / 2, y0, title, ha="center", va="center", fontsize=title_size, fontweight="bold" if bold else "normal")
            i = 1
        for j, ln in enumerate(lines):
            ax.text(x + w / 2, y0 - step * (i + j), ln, ha="center", va="center", fontsize=body_size)
    return p


def lane(ax, x, y, w, h, label, shade="#f2f2f2", label_w=7.5):
    ax.add_patch(Rectangle((x, y), w, h, lw=0.6, ec=K, fc=shade, zorder=0))
    ax.add_patch(Rectangle((x, y), label_w, h, lw=0.6, ec=K, fc="#d9d9d9", zorder=0))
    ax.text(x + label_w / 2, y + h / 2, label, rotation=90, ha="center", va="center", fontsize=6.6, fontweight="bold")


def arrow(ax, pts, style="-", lw=0.8, head=True, both=False, label=None, lpos=0.5, loff=(0, 0.9), lsize=5.4, color=K, lha="center", zorder=5):
    """Polyline arrow through points; arrowhead at the end."""
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    ax.add_line(Line2D(xs[:-1] + [xs[-1]], ys[:-1] + [ys[-1]], lw=lw, ls=style, color=color, zorder=zorder, solid_capstyle="butt"))
    if head:
        a = FancyArrowPatch(pts[-2], pts[-1], arrowstyle="-|>", mutation_scale=6.5, lw=lw, color=color, shrinkA=0, shrinkB=0, zorder=zorder + 1)
        ax.add_patch(a)
    if both:
        a = FancyArrowPatch(pts[1], pts[0], arrowstyle="-|>", mutation_scale=6.5, lw=lw, color=color, shrinkA=0, shrinkB=0, zorder=zorder + 1)
        ax.add_patch(a)
    if label:
        # place label on the longest segment
        segs = [(i, ((pts[i + 1][0] - pts[i][0]) ** 2 + (pts[i + 1][1] - pts[i][1]) ** 2) ** 0.5) for i in range(len(pts) - 1)]
        i = max(segs, key=lambda s: s[1])[0]
        lx = pts[i][0] + (pts[i + 1][0] - pts[i][0]) * lpos + loff[0]
        ly = pts[i][1] + (pts[i + 1][1] - pts[i][1]) * lpos + loff[1]
        ax.text(lx, ly, label, ha=lha, va="center", fontsize=lsize, bbox=dict(fc="white", ec="none", pad=0.4), zorder=zorder + 2)


def badge(ax, x, y, txt, r=1.25, size=5.6):
    ax.add_patch(Circle((x, y), r, fc="black", ec="black", zorder=8))
    ax.text(x, y - 0.05, txt, color="white", ha="center", va="center", fontsize=size, fontweight="bold", zorder=9)


# ---------------------------------------------------------------- icons (line art)
def icon_person(ax, cx, cy, s=1.0):
    ax.add_patch(Circle((cx, cy + 1.25 * s), 0.62 * s, fc="white", ec=K, lw=0.7, zorder=6))
    ax.add_patch(Polygon([(cx - 1.1 * s, cy - 0.9 * s), (cx + 1.1 * s, cy - 0.9 * s), (cx + 0.75 * s, cy + 0.45 * s), (cx - 0.75 * s, cy + 0.45 * s)], closed=True, fc="white", ec=K, lw=0.7, zorder=6))


def icon_hotel(ax, cx, cy, s=1.0):
    ax.add_patch(Rectangle((cx - 1.0 * s, cy - 1.0 * s), 2.0 * s, 2.4 * s, fc="white", ec=K, lw=0.7, zorder=6))
    for r in range(3):
        for c in range(2):
            ax.add_patch(Rectangle((cx - 0.7 * s + c * 0.85 * s, cy + 0.75 * s - r * 0.62 * s), 0.45 * s, 0.35 * s, fc=K, ec=K, lw=0.3, zorder=7))


def icon_health(ax, cx, cy, s=1.0):
    ax.add_patch(Rectangle((cx - 1.1 * s, cy - 1.0 * s), 2.2 * s, 2.2 * s, fc="white", ec=K, lw=0.7, zorder=6))
    ax.add_patch(Rectangle((cx - 0.22 * s, cy - 0.65 * s), 0.44 * s, 1.5 * s, fc=K, ec=K, zorder=7))
    ax.add_patch(Rectangle((cx - 0.75 * s, cy - 0.12 * s), 1.5 * s, 0.44 * s, fc=K, ec=K, zorder=7))


def icon_chart(ax, cx, cy, s=1.0):
    ax.add_patch(Rectangle((cx - 1.1 * s, cy - 1.0 * s), 2.2 * s, 2.2 * s, fc="white", ec=K, lw=0.7, zorder=6))
    for i, hgt in enumerate([0.6, 1.1, 1.6]):
        ax.add_patch(Rectangle((cx - 0.75 * s + i * 0.55 * s, cy - 0.75 * s), 0.38 * s, hgt * s, fc=K, ec=K, zorder=7))


def icon_gear(ax, cx, cy, s=1.0):
    import numpy as np

    pts = []
    for i in range(16):
        a = i * np.pi / 8
        r = 1.15 * s if i % 2 == 0 else 0.85 * s
        pts.append((cx + r * np.cos(a), cy + r * np.sin(a)))
    ax.add_patch(Polygon(pts, closed=True, fc="white", ec=K, lw=0.7, zorder=6))
    ax.add_patch(Circle((cx, cy), 0.35 * s, fc="white", ec=K, lw=0.7, zorder=7))


def icon_db(ax, cx, cy, s=1.0):
    from matplotlib.patches import Ellipse, Arc

    ax.add_patch(Rectangle((cx - 1.0 * s, cy - 0.9 * s), 2.0 * s, 1.8 * s, fc="white", ec="none", zorder=6))
    for xx in (cx - 1.0 * s, cx + 1.0 * s):
        ax.add_line(Line2D([xx, xx], [cy - 0.9 * s, cy + 0.9 * s], color=K, lw=0.7, zorder=7))
    ax.add_patch(Ellipse((cx, cy + 0.9 * s), 2.0 * s, 0.6 * s, fc="white", ec=K, lw=0.7, zorder=8))
    for yy in (cy - 0.9 * s, cy - 0.3 * s, cy + 0.3 * s):
        ax.add_patch(Arc((cx, yy), 2.0 * s, 0.6 * s, theta1=180, theta2=360, ec=K, lw=0.7, zorder=8))


def icon_chain(ax, cx, cy, s=1.0):
    for i in range(3):
        ax.add_patch(FancyBboxPatch((cx - 1.4 * s + i * 1.0 * s, cy - 0.35 * s), 0.8 * s, 0.7 * s, boxstyle="round,pad=0,rounding_size=0.15", fc="white", ec=K, lw=0.7, zorder=6))
        if i < 2:
            ax.add_line(Line2D([cx - 0.6 * s + i * 1.0 * s, cx - 0.4 * s + i * 1.0 * s], [cy, cy], color=K, lw=0.7, zorder=7))


def icon_key(ax, cx, cy, s=1.0):
    ax.add_patch(Circle((cx - 0.6 * s, cy), 0.45 * s, fc="white", ec=K, lw=0.7, zorder=6))
    ax.add_line(Line2D([cx - 0.15 * s, cx + 1.0 * s], [cy, cy], color=K, lw=0.8, zorder=6))
    ax.add_line(Line2D([cx + 0.7 * s, cx + 0.7 * s], [cy, cy - 0.35 * s], color=K, lw=0.8, zorder=6))
    ax.add_line(Line2D([cx + 0.95 * s, cx + 0.95 * s], [cy, cy - 0.35 * s], color=K, lw=0.8, zorder=6))


def icon_lock(ax, cx, cy, s=1.0):
    from matplotlib.patches import Arc

    ax.add_patch(Arc((cx, cy + 0.25 * s), 1.1 * s, 1.3 * s, theta1=0, theta2=180, ec=K, lw=0.8, zorder=6))
    ax.add_patch(Rectangle((cx - 0.75 * s, cy - 0.85 * s), 1.5 * s, 1.1 * s, fc=K, ec=K, zorder=7))


def save(fig, path):
    fig.savefig(path + ".png", dpi=600)
    fig.savefig(path + ".pdf")
    plt.close(fig)
