/**
 * Deploys ParticipantRegistry and ContactRecordManager to RPC_URL and writes build/deployment.json.
 * Usage: node scripts/deploy.js   (uses DEPLOYER_PRIVATE_KEY, or the first unlocked account)
 */
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const config = require("../backend/src/config");
const { deploySystem, ROOT } = require("../backend/src/lib/contracts");

(async () => {
  const provider = new ethers.providers.JsonRpcProvider(config.rpcUrl);
  const signer = process.env.DEPLOYER_PRIVATE_KEY ? new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider) : provider.getSigner(0);
  const s = await deploySystem(signer);
  const net = await provider.getNetwork();
  const dep = { chainId: net.chainId, registry: s.registry.address, crm: s.crm.address, deployedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(ROOT, "build", "deployment.json"), JSON.stringify(dep, null, 2));
  console.log(dep);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
