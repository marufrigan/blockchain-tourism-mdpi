/**
 * Compiles the PCTF contracts with solc-js 0.8.19 (optimizer on, 200 runs).
 * Output: build/artifacts.json  { ContractName: { abi, bytecode } }
 * Usage: node scripts/compile.js
 */
const fs = require("fs");
const path = require("path");
const solc = require("solc");

const ROOT = path.join(__dirname, "..");
const CONTRACTS = path.join(ROOT, "contracts");
const files = fs.readdirSync(CONTRACTS).filter((f) => f.endsWith(".sol"));

const input = {
  language: "Solidity",
  sources: Object.fromEntries(files.map((f) => [f, { content: fs.readFileSync(path.join(CONTRACTS, f), "utf8") }])),
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "storageLayout"] } },
  },
};

function findImports(p) {
  const full = path.join(CONTRACTS, p.replace(/^\.\//, ""));
  return fs.existsSync(full) ? { contents: fs.readFileSync(full, "utf8") } : { error: "not found" };
}

const out = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
const errors = (out.errors || []).filter((e) => e.severity === "error");
(out.errors || []).forEach((e) => console.error(e.formattedMessage));
if (errors.length) process.exit(1);

const artifacts = {};
for (const [file, contracts] of Object.entries(out.contracts)) {
  for (const [name, c] of Object.entries(contracts)) {
    if (!c.evm.bytecode.object) continue; // abstract
    artifacts[name] = { abi: c.abi, bytecode: "0x" + c.evm.bytecode.object, storageLayout: c.storageLayout, source: file };
  }
}
fs.mkdirSync(path.join(ROOT, "build"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "build", "artifacts.json"), JSON.stringify(artifacts, null, 1));
console.log("Compiled:", Object.keys(artifacts).join(", "), "with solc", solc.version());
