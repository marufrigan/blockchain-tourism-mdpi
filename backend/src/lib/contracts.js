const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const ROOT = path.join(__dirname, "..", "..", "..");

function artifacts() {
  const p = path.join(ROOT, "build", "artifacts.json");
  if (!fs.existsSync(p)) throw new Error("build/artifacts.json missing: run `npm run compile`");
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

async function deploy(signer, name, args = []) {
  const a = artifacts()[name];
  const f = new ethers.ContractFactory(a.abi, a.bytecode, signer);
  const c = await f.deploy(...args);
  const rc = await c.deployTransaction.wait();
  return { contract: c, gasUsed: rc.gasUsed.toNumber(), address: c.address };
}

/** Deploy the PCTF system: registry, record manager and (optionally) the on-chain baseline. */
async function deploySystem(signer, { withBaseline = false } = {}) {
  const reg = await deploy(signer, "ParticipantRegistry");
  const crm = await deploy(signer, "ContactRecordManager", [reg.address]);
  const out = { registry: reg, crm };
  if (withBaseline) out.baseline = await deploy(signer, "FullOnChainRecordManager", [reg.address]);
  return out;
}

function at(name, address, signerOrProvider) {
  return new ethers.Contract(address, artifacts()[name].abi, signerOrProvider);
}

module.exports = { artifacts, deploy, deploySystem, at, ROOT };
