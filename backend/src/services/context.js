/** Builds the shared service context (chain contracts, storage, key store, audit, key release). */
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const config = require("../config");
const { at } = require("../lib/contracts");
const { toKey } = require("../utils/crypto");
const { StorageService } = require("./storage.service");
const { KeyStore } = require("./keystore.service");
const { AuditLog } = require("./audit.service");
const { KeyReleaseService } = require("./keyRelease.service");

let ctx = null;

function getContext() {
  if (ctx) return ctx;
  if (!fs.existsSync(config.deploymentFile)) throw new Error("build/deployment.json missing: run `npm run deploy`");
  const dep = JSON.parse(fs.readFileSync(config.deploymentFile, "utf8"));
  const provider = new ethers.providers.JsonRpcProvider(config.rpcUrl);
  const registry = at("ParticipantRegistry", dep.registry, provider);
  const crm = at("ContactRecordManager", dep.crm, provider);
  const storage = new StorageService({ dataDir: config.dataDir, mode: config.storageMode });
  const keystore = new KeyStore({ dataDir: config.dataDir, kek: toKey(config.kekHex, "KEK_HEX") });
  const audit = new AuditLog({ dataDir: config.dataDir });
  const pepper = toKey(config.pepperHex, "PSEUDONYM_PEPPER_HEX");
  const krs = new KeyReleaseService({ registry, crm, keystore, storage, audit, pepper, authWindowSec: config.authWindowSec, nonceLog: path.join(config.dataDir, "nonces.log") });
  ctx = { provider, registry, crm, storage, keystore, audit, pepper, krs };
  return ctx;
}

module.exports = { getContext };
