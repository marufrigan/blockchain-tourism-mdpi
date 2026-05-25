/**
 * PCTF gas analysis — ethers v6 · Ganache
 *
 * cd scripts/gas-analysis && npm install
 * RPC_URL=http://127.0.0.1:8545 node gas-analysis.mjs
 *
 * Uses Ganache unlocked eth_accounts: 0 = Admin (deployer), 1 = Tourist, 2 = Hotel, 3 = HealthAuthority.
 * Override any slot with GAS_PK_<index> if your node does not unlock accounts.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { ethers } from "ethers";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
dotenv.config({ path: path.join(ROOT, ".env") });

/** Prefer GAS_RPC_URL so paper runs can target :8545 without changing app RPC_URL in .env */
const RPC_URL =
  process.env.GAS_RPC_URL || process.env.RPC_URL || "http://127.0.0.1:8545";
const GWEI = 20n;
const WEI_PER_GWEI = 10n ** 9n;

function loadArtifact(name) {
  const p = path.join(ROOT, "backend", "src", "abi", `${name}.json`);
  if (!fs.existsSync(p)) {
    throw new Error(`Missing ${p}. Run: truffle migrate && npm run export-abi`);
  }
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  return { address: j.address, abi: j.abi };
}

/**
 * Ganache unlocks eth_accounts[0..n]; index 0 is the Truffle deployer (bootstrap Admin).
 * Optional GAS_PK_i overrides with an explicit private key.
 */
async function unlockedSigner(provider, index) {
  const pk = process.env[`GAS_PK_${index}`];
  if (pk) {
    return new ethers.Wallet(pk.trim(), provider);
  }
  const accounts = await provider.send("eth_accounts", []);
  if (!accounts[index]) {
    throw new Error(
      `eth_accounts[${index}] missing — need at least ${index + 1} Ganache accounts`
    );
  }
  return provider.getSigner(accounts[index]);
}

function ethCostAt20Gwei(gasUsed) {
  const g = BigInt(gasUsed);
  const wei = g * GWEI * WEI_PER_GWEI;
  return ethers.formatEther(wei);
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const net = await provider.getNetwork();
  console.log(`RPC ${RPC_URL}  chainId=${net.chainId}`);

  const regArt = loadArtifact("ParticipantRegistry");
  const crArt = loadArtifact("ContactRecordManager");
  if (!regArt.address || !crArt.address) {
    throw new Error("Missing deployed address in backend/src/abi/*.json");
  }

  const admin = await unlockedSigner(provider, 0);
  const tourist = await unlockedSigner(provider, 1);
  const hotel = await unlockedSigner(provider, 2);
  const health = await unlockedSigner(provider, 3);

  console.log("Admin (Ganache account 0 / deployer):", await admin.getAddress());

  const registry = new ethers.Contract(regArt.address, regArt.abi, admin);
  const cr = new ethers.Contract(crArt.address, crArt.abi, admin);

  const rows = [];
  const chartOps = [];

  const subjectHash = ethers.keccak256(ethers.toUtf8Bytes("pctf-gas-subject"));
  const offRef = "local:gas-ref";

  async function pushRow(operation, role, gasUsed, status) {
    const g = BigInt(gasUsed);
    rows.push({
      operation,
      role,
      gasUsed: g.toString(),
      ethCost20Gwei: ethCostAt20Gwei(g),
      status,
    });
    let kind = "success";
    if (status.toLowerCase().includes("revert")) kind = "revert";
    else if (status.toLowerCase().includes("read")) kind = "read";
    chartOps.push({
      label: operation,
      gas: Number(g),
      kind,
    });
    console.log(
      `${operation} | ${role} | gas=${g} | ETH@20Gwei=${ethCostAt20Gwei(g)} | ${status}`
    );
  }

  async function isRegistered(addr) {
    try {
      return await registry.isRegistered(addr);
    } catch {
      return false;
    }
  }

  // --- 1) registerParticipant (Admin): fresh address ---
  const freshUser = ethers.Wallet.createRandom();
  const tx1 = await registry.registerParticipant(
    freshUser.address,
    2,
    `gas-reg-${Date.now()}`
  );
  const r1 = await tx1.wait();
  await pushRow(
    "registerParticipant",
    "Admin",
    r1.gasUsed,
    "success"
  );

  // --- Ensure hotel, tourist, health for following steps ---
  if (!(await isRegistered(hotel.address))) {
    await (await registry.registerParticipant(hotel.address, 2, "hotel")).wait();
  }
  if (!(await isRegistered(tourist.address))) {
    await (await registry.registerParticipant(tourist.address, 1, "tourist")).wait();
  }
  if (!(await isRegistered(health.address))) {
    await (await registry.registerParticipant(health.address, 3, "health")).wait();
  }

  // --- 2) createRecord (Hotel) ---
  const tx2 = await cr
    .connect(hotel)
    .createRecord(subjectHash, `${offRef}-c`, "hotel_visit", "active");
  const r2 = await tx2.wait();
  await pushRow("createRecord", "Hotel", r2.gasUsed, "success");

  const n = await cr.getRecordCount();
  const rid = Number(n);

  // --- 3) updateRecordStatus (HealthAuthority) ---
  const tx3 = await cr.connect(health).updateRecordStatus(rid, "verified");
  const r3 = await tx3.wait();
  await pushRow("updateRecordStatus", "HealthAuthority", r3.gasUsed, "success");

  // --- 4) getRecord: no user gas ---
  await pushRow("getRecord (static call)", "HealthAuthority", 0n, "read (no user gas)");

  // --- 5) Unauthorised createRecord (Tourist) — explicit gasLimit avoids estimateGas revert failures ---
  let r4;
  try {
    const tx4 = await cr.connect(tourist).createRecord(
      subjectHash,
      `${offRef}-x`,
      "hotel_visit",
      "active",
      { gasLimit: 500000n }
    );
    r4 = await tx4.wait();
  } catch (e) {
    if (e?.receipt) r4 = e.receipt;
    else throw e;
  }
  const ok = r4.status === 1n || r4.status === 1;
  const st = ok ? "unexpected success" : "revert";
  await pushRow(
    "createRecord (unauthorised)",
    "Tourist",
    r4.gasUsed,
    st
  );

  // --- 6) Batch 5 registrations: sum gas ---
  let batchSum = 0n;
  for (let i = 0; i < 5; i++) {
    const w = ethers.Wallet.createRandom();
    if (await isRegistered(w.address)) continue;
    const txb = await registry.registerParticipant(w.address, 1, `batch-${i}`);
    const rb = await txb.wait();
    batchSum += rb.gasUsed;
  }
  await pushRow(
    "batch 5× registerParticipant (sum)",
    "Admin",
    batchSum,
    "success (aggregate)"
  );

  // --- CSV ---
  const header = "Operation,Role,Gas Used,ETH Cost at 20 Gwei,Status";
  const lines = [header];
  for (const r of rows) {
    lines.push(
      `"${r.operation}","${r.role}",${r.gasUsed},${r.ethCost20Gwei},"${r.status}"`
    );
  }
  const csvPath = path.join(ROOT, "gas-report.csv");
  fs.writeFileSync(csvPath, lines.join("\n"), "utf8");
  console.log("\nWrote", csvPath);

  const maxGas = Math.max(
    ...chartOps.map((o) => o.gas),
    200000
  );
  const yMax = Math.ceil(maxGas * 1.15 / 50000) * 50000;

  const chartPayload = {
    title: "PCTF Smart Contract Gas Consumption Analysis",
    yMax,
    labels: chartOps.map((o) => o.label),
    successGas: chartOps.map((o) => (o.kind === "success" ? o.gas : 0)),
    revertGas: chartOps.map((o) => (o.kind === "revert" ? o.gas : 0)),
    readGas: chartOps.map((o) => (o.kind === "read" ? o.gas : 0)),
    operations: chartOps.map((o) => ({
      name: o.label,
      gas: o.gas,
      category: o.kind,
    })),
  };
  const jsonPath = path.join(ROOT, "gas-chart-data.json");
  fs.writeFileSync(jsonPath, JSON.stringify(chartPayload, null, 2), "utf8");
  console.log("Wrote", jsonPath);

  const htmlPath = path.join(ROOT, "gas-chart.html");
  fs.writeFileSync(htmlPath, buildChartHtml(chartPayload), "utf8");
  console.log("Wrote", htmlPath);
  console.log("\nOpen gas-chart.html in a browser for the bar chart screenshot.");
}

function buildChartHtml(data) {
  const labels = JSON.stringify(data.labels || data.operations.map((o) => o.name));
  const successGas = JSON.stringify(data.successGas);
  const revertGas = JSON.stringify(data.revertGas);
  const readGas = JSON.stringify(data.readGas);
  const yMax = data.yMax || 200000;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>PCTF Gas Analysis</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
  <style>
    body { font-family: Georgia, "Times New Roman", serif; background: #fafafa; color: #1a1a1a; margin: 28px; }
    h1 { font-size: 18px; font-weight: 600; margin-bottom: 6px; }
    p.sub { font-size: 12px; color: #444; margin-top: 0; }
    p.caption { font-size: 11px; color: #333; margin-top: 16px; line-height: 1.45; max-width: 920px; }
    .box { max-width: 1000px; }
  </style>
</head>
<body>
  <div class="box">
    <h1>PCTF Smart Contract Gas Consumption Analysis</h1>
    <p class="sub">Grouped bars: blue = successful writes; red = revert; green = read (off-chain static call, zero user gas).</p>
    <canvas id="g" height="360"></canvas>
    <p class="caption"><strong>Figure 6.</strong> <em>PCTF Smart Contract Gas Consumption Analysis</em> — grouped bar chart of gas units per operation; blue = successful writes, red = revert (access denied), green = read / no user gas (static call).</p>
  </div>
  <script>
    const labels = ${labels};
    const yMax = ${yMax};
    new Chart(document.getElementById('g'), {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            label: 'Successful writes',
            data: ${successGas},
            backgroundColor: 'rgba(13, 110, 253, 0.85)',
            borderWidth: 0
          },
          {
            label: 'Revert (access denied)',
            data: ${revertGas},
            backgroundColor: 'rgba(220, 53, 69, 0.85)',
            borderWidth: 0
          },
          {
            label: 'Read (no user gas)',
            data: ${readGas},
            backgroundColor: 'rgba(40, 167, 69, 0.85)',
            borderWidth: 0
          }
        ]
      },
      options: {
        responsive: true,
        plugins: {
          title: { display: true, text: 'PCTF Smart Contract Gas Consumption', font: { size: 15 } },
          legend: { position: 'bottom', labels: { boxWidth: 14, font: { size: 11 } } }
        },
        scales: {
          x: {
            title: { display: true, text: 'Operation' },
            ticks: { maxRotation: 35, minRotation: 20, font: { size: 9 } }
          },
          y: {
            beginAtZero: true,
            max: yMax,
            title: { display: true, text: 'Gas units' }
          }
        }
      }
    });
  </script>
</body>
</html>`;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
