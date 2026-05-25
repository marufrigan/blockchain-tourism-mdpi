import pandas as pd
import matplotlib.pyplot as plt


CSV_PATH = "simulation_results/registration_results.csv"


def build_batches(df, batch_size=10):
    batch_rows = []
    total = len(df)
    for start in range(1, total + 1, batch_size):
        end = min(start + batch_size - 1, total)
        batch_df = df[(df["userIndex"] >= start) & (df["userIndex"] <= end)]
        batch_rows.append(
            {
                "label": f"{start}-{end}",
                "avgGasUsed": batch_df["gasUsed"].mean(),
                "avgTimeMs": batch_df["timeTaken(ms)"].mean(),
            }
        )
    return pd.DataFrame(batch_rows)


def plot_bar(labels, values, title, y_label, out_file, color, edge, y_limits=None):
    plt.style.use("seaborn-v0_8-whitegrid")
    fig, ax = plt.subplots(figsize=(12, 6), dpi=300)

    bars = ax.bar(labels, values, color=color, edgecolor=edge, linewidth=1.0)
    ax.set_title(title, fontsize=14, fontweight="bold")
    ax.set_xlabel("User Batch (Index Range)", fontsize=11)
    ax.set_ylabel(y_label, fontsize=11)
    ax.tick_params(axis="x", rotation=30)

    if y_limits:
        ax.set_ylim(*y_limits)

    offset = (max(values) - min(values)) * 0.03 if max(values) != min(values) else 1
    for b, v in zip(bars, values):
        ax.text(
            b.get_x() + b.get_width() / 2,
            v + offset,
            f"{v:.1f}",
            ha="center",
            va="bottom",
            fontsize=8,
        )

    plt.tight_layout()
    plt.savefig(out_file, bbox_inches="tight")
    plt.close()


def main():
    df = pd.read_csv(CSV_PATH)
    df = df[df["status"] == "success"].copy()
    df["userIndex"] = pd.to_numeric(df["userIndex"])
    df["gasUsed"] = pd.to_numeric(df["gasUsed"])
    df["timeTaken(ms)"] = pd.to_numeric(df["timeTaken(ms)"])
    df.sort_values("userIndex", inplace=True)

    batches = build_batches(df, batch_size=10)

    plot_bar(
        labels=batches["label"].tolist(),
        values=batches["avgGasUsed"].tolist(),
        title="Large-Scale Registration Simulation: Gas by Batch",
        y_label="Average Gas Used",
        out_file="figureX_gas_per_batch.png",
        color="#2E86DE",
        edge="#1B4F72",
        y_limits=(73120, 73320),
    )

    plot_bar(
        labels=batches["label"].tolist(),
        values=batches["avgTimeMs"].tolist(),
        title="Large-Scale Registration Simulation: Time by Batch",
        y_label="Average Time (ms)",
        out_file="figureY_time_per_batch.png",
        color="#27AE60",
        edge="#145A32",
        y_limits=(25, 45),
    )

    print("Saved:")
    print("- figureX_gas_per_batch.png")
    print("- figureY_time_per_batch.png")


if __name__ == "__main__":
    main()
