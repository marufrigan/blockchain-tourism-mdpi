/**
 * Copies contract ABI and deployed address from Truffle build artifacts into backend/src/abi.
 * Run after: truffle migrate [--reset]
 *
 * Usage: node scripts/export-abi.js
 * Env: EXPORT_ABI_NETWORK_ID forces a network key from artifacts (e.g. 5777).
 *       Otherwise the highest numeric network id in the artifact is used (latest migrate).
 */
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const ROOT = path.join(__dirname, "..");
const BUILD = path.join(ROOT, "build", "contracts");
const OUT = path.join(ROOT, "backend", "src", "abi");

const CONTRACTS = ["ParticipantRegistry", "ContactRecordManager"];

function pickNetworkId(networks) {
  if (!networks || typeof networks !== "object") return null;
  const keys = Object.keys(networks).filter((k) => /^\d+$/.test(k));
  if (keys.length === 0) return null;
  return keys.map((k) => BigInt(k)).sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))[0].toString();
}

function main() {
  if (!fs.existsSync(BUILD)) {
    console.error("Missing build/contracts. Run: truffle compile && truffle migrate");
    process.exit(1);
  }
  fs.mkdirSync(OUT, { recursive: true });

  for (const name of CONTRACTS) {
    const artifactPath = path.join(BUILD, `${name}.json`);
    if (!fs.existsSync(artifactPath)) {
      console.error("Missing artifact:", artifactPath);
      process.exit(1);
    }
    const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
    const resolvedId =
      process.env.EXPORT_ABI_NETWORK_ID ||
      pickNetworkId(artifact.networks) ||
      "5777";
    const net =
      resolvedId && artifact.networks && artifact.networks[resolvedId];
    const address = net && net.address ? net.address : "";

    const slim = {
      contractName: name,
      abi: artifact.abi,
      address,
      networkId: resolvedId || "",
    };

    fs.writeFileSync(
      path.join(OUT, `${name}.json`),
      JSON.stringify(slim, null, 2)
    );
    console.log(
      `Wrote ${name}.json networkId=${resolvedId || "?"} address=${address || "(run migrate on this network)"}`
    );
  }
}

main();
