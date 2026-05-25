const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const config = require("../config");

function loadArtifact(name) {
  const p = path.join(config.abiDir, `${name}.json`);
  if (!fs.existsSync(p)) {
    throw new Error(
      `Missing ${p}. Run: truffle migrate && npm run export-abi`
    );
  }
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function getSigner(overridePk) {
  const pk = (overridePk || config.signerPrivateKey || "").trim();
  if (!pk) {
    throw new Error(
      "Set SIGNER_PRIVATE_KEY in .env or send X-Signer-Private-Key header (demo only)"
    );
  }
  const provider = new ethers.providers.JsonRpcProvider(config.rpcUrl);
  return new ethers.Wallet(pk.startsWith("0x") ? pk : `0x${pk}`, provider);
}

function getRegistry(signer) {
  const art = loadArtifact("ParticipantRegistry");
  if (!art.address) {
    throw new Error("ParticipantRegistry address empty — run migrate + export-abi");
  }
  return new ethers.Contract(art.address, art.abi, signer);
}

function getRecords(signer) {
  const art = loadArtifact("ContactRecordManager");
  if (!art.address) {
    throw new Error("ContactRecordManager address empty — run migrate + export-abi");
  }
  return new ethers.Contract(art.address, art.abi, signer);
}

async function callGetRecord(recordId, viewerWallet) {
  const art = loadArtifact("ContactRecordManager");
  const provider = new ethers.providers.JsonRpcProvider(config.rpcUrl);
  const c = new ethers.Contract(art.address, art.abi, provider);
  return c.getRecord(recordId, { from: viewerWallet.address });
}

async function callGetRecordsBySubjectHash(subjectHash, viewerWallet) {
  const art = loadArtifact("ContactRecordManager");
  const provider = new ethers.providers.JsonRpcProvider(config.rpcUrl);
  const c = new ethers.Contract(art.address, art.abi, provider);
  return c.getRecordsBySubjectHash(subjectHash, { from: viewerWallet.address });
}

module.exports = {
  loadArtifact,
  getSigner,
  getRegistry,
  getRecords,
  callGetRecord,
  callGetRecordsBySubjectHash,
};
