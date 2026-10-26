// Adds prefunded accounts keccak256("pctf-besu-<i>"), i = 0..N-1, to the QBFT genesis template.
const fs = require("fs");
const { ethers } = require("ethers");
const N = Number(process.env.ACCOUNTS || 64);
const cfg = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
for (let i = 0; i < N; i++) {
  const w = new ethers.Wallet(ethers.utils.keccak256(ethers.utils.toUtf8Bytes(`pctf-besu-${i}`)));
  cfg.genesis.alloc[w.address.slice(2).toLowerCase()] = { balance: "0x" + (10n ** 24n).toString(16) };
}
process.stdout.write(JSON.stringify(cfg, null, 2));
