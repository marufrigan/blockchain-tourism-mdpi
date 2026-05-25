const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
require("dotenv").config();

const CONFIG = {
  rpcUrl: "http://127.0.0.1:7545",
  fallbackRpcUrls: ["http://127.0.0.1:8545"],
  totalUsers: 100,
  progressEvery: 10,
  txDelayMs: 100,
  outputDir: path.join(__dirname, "..", "simulation_results"),
  outputFile: path.join(
    __dirname,
    "..",
    "simulation_results",
    "registration_results.csv"
  ),
  roleMap: {
    0: "Admin",
    1: "Tourist",
    2: "Hotel",
    3: "HealthAuthority",
    4: "TourismAuthority",
  },
};

async function resolveProvider() {
  const candidates = [
    process.env.SIM_RPC_URL,
    CONFIG.rpcUrl,
    process.env.RPC_URL,
    ...CONFIG.fallbackRpcUrls,
  ].filter(Boolean);

  const uniqueCandidates = [...new Set(candidates)];
  let lastError = null;

  for (const rpcUrl of uniqueCandidates) {
    try {
      const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
      const accounts = await provider.listAccounts();
      if (accounts.length > 0) {
        return { provider, accounts, rpcUrl };
      }
      lastError = new Error(`No unlocked accounts on ${rpcUrl}`);
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(
    `Could not connect to Ganache on: ${uniqueCandidates.join(", ")}. ` +
      `Last error: ${lastError ? lastError.message : "unknown"}`
  );
}

function loadRegistryArtifact() {
  const abiPath = path.join(
    __dirname,
    "..",
    "backend",
    "src",
    "abi",
    "ParticipantRegistry.json"
  );
  if (!fs.existsSync(abiPath)) {
    throw new Error(
      `Missing ABI file at ${abiPath}. Run migrations/export-abi first.`
    );
  }

  const artifact = JSON.parse(fs.readFileSync(abiPath, "utf8"));
  if (!artifact.address || !artifact.abi) {
    throw new Error("ParticipantRegistry artifact missing address or abi.");
  }

  return artifact;
}

function buildRoleDistribution() {
  const roles = [];

  for (let i = 0; i < 70; i++) roles.push(1); // Tourist
  for (let i = 0; i < 15; i++) roles.push(2); // Hotel
  for (let i = 0; i < 10; i++) roles.push(3); // HealthAuthority
  for (let i = 0; i < 5; i++) roles.push(4); // TourismAuthority

  if (roles.length !== CONFIG.totalUsers) {
    throw new Error(
      `Role distribution length mismatch: expected ${CONFIG.totalUsers}, got ${roles.length}`
    );
  }

  return roles;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function toCsv(results) {
  const header =
    "userIndex,address,role,gasUsed,timeTaken(ms),txHash,status,error";
  const rows = results.map((r) =>
    [
      r.userIndex,
      r.address,
      r.role,
      r.gasUsed,
      r.timeTaken,
      r.txHash,
      r.status,
      r.error || "",
    ]
      .map(csvEscape)
      .join(",")
  );
  return [header, ...rows].join("\n");
}

function summarize(results) {
  const success = results.filter((r) => r.status === "success");
  const failed = results.filter((r) => r.status === "failed");

  const totalGas = success.reduce(
    (sum, r) => sum + Number(r.gasUsed || 0),
    0
  );
  const totalTime = success.reduce(
    (sum, r) => sum + Number(r.timeTaken || 0),
    0
  );

  return {
    totalUsers: results.length,
    successful: success.length,
    failed: failed.length,
    avgGasUsed: success.length ? Math.round(totalGas / success.length) : 0,
    avgTimeMs: success.length ? Math.round(totalTime / success.length) : 0,
  };
}

async function registerOne({
  contract,
  userIndex,
  walletAddress,
  role,
  label,
}) {
  const start = Date.now();
  try {
    const tx = await contract.registerParticipant(walletAddress, role, label);
    const receipt = await tx.wait();
    const end = Date.now();

    return {
      userIndex,
      address: walletAddress,
      role,
      gasUsed: receipt.gasUsed.toString(),
      timeTaken: end - start,
      txHash: tx.hash,
      status: "success",
      error: "",
    };
  } catch (error) {
    const end = Date.now();
    return {
      userIndex,
      address: walletAddress,
      role,
      gasUsed: "",
      timeTaken: end - start,
      txHash: "",
      status: "failed",
      error: (error && error.message ? error.message : String(error)).slice(
        0,
        500
      ),
    };
  }
}

async function runSimulation() {
  const artifact = loadRegistryArtifact();
  const roles = buildRoleDistribution();

  const { provider, accounts, rpcUrl } = await resolveProvider();
  const codeAtRegistry = await provider.getCode(artifact.address);
  if (!codeAtRegistry || codeAtRegistry === "0x") {
    throw new Error(
      `No contract code at registry address ${artifact.address} on ${rpcUrl}. ` +
        "Start Ganache on the same network used for deployment, then run: " +
        "`npx truffle migrate --network ganache --reset && npm run export-abi`."
    );
  }

  const adminSigner = provider.getSigner(accounts[0]);
  const contract = new ethers.Contract(
    artifact.address,
    artifact.abi,
    adminSigner
  );

  const adminAddress = await adminSigner.getAddress();
  console.log("Simulation started");
  console.log(`RPC: ${rpcUrl}`);
  console.log(`Registry: ${artifact.address}`);
  console.log(`Admin signer: ${adminAddress}`);
  console.log(`Total users: ${CONFIG.totalUsers}`);

  const results = [];

  for (let i = 0; i < roles.length; i++) {
    const userIndex = i + 1;
    const role = roles[i];
    const wallet = ethers.Wallet.createRandom();

    const record = await registerOne({
      contract,
      userIndex,
      walletAddress: wallet.address,
      role,
      label: `sim-user-${userIndex}-${CONFIG.roleMap[role] || role}`,
    });

    results.push(record);

    if (userIndex % CONFIG.progressEvery === 0) {
      console.log(`Registered ${userIndex} users...`);
    }

    if (CONFIG.txDelayMs > 0) {
      await sleep(CONFIG.txDelayMs);
    }
  }

  fs.mkdirSync(CONFIG.outputDir, { recursive: true });
  fs.writeFileSync(CONFIG.outputFile, toCsv(results), "utf8");

  const summary = summarize(results);

  console.log("\nSimulation complete.");
  console.log(`Total users: ${summary.totalUsers}`);
  console.log(`Successful registrations: ${summary.successful}`);
  console.log(`Failed registrations: ${summary.failed}`);
  console.log(`Average gas used: ${summary.avgGasUsed}`);
  console.log(`Average time per registration: ${summary.avgTimeMs} ms`);
  console.log(`CSV saved to: ${CONFIG.outputFile}`);
}

runSimulation().catch((error) => {
  console.error("Simulation failed to start:", error.message);
  process.exit(1);
});
