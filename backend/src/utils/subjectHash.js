const { ethers } = require("ethers");

/**
 * Deterministic pseudonymous subject identifier for on-chain indexing.
 * @param {string} subjectSeed — opaque demo token (not stored on-chain as plaintext in production workflows)
 */
function hashSubjectSeed(subjectSeed) {
  return ethers.utils.keccak256(ethers.utils.toUtf8Bytes(String(subjectSeed)));
}

module.exports = { hashSubjectSeed };
