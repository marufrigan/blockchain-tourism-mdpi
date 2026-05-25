const {
  getSigner,
  getRegistry,
  getRecords,
  callGetRecord,
  callGetRecordsBySubjectHash,
} = require("../services/blockchain.service");
const { storeEncryptedPayload, loadCiphertextByReference } = require("../services/storage.service");
const { decryptPayload } = require("../utils/crypto");
const { hashSubjectSeed } = require("../utils/subjectHash");

function headerPk(req) {
  const h = req.headers["x-signer-private-key"];
  return typeof h === "string" && h.length > 0 ? h.trim() : null;
}

function normaliseSubjectHash(hashParam) {
  let h = String(hashParam || "").trim();
  if (!h.startsWith("0x")) {
    h = `0x${h}`;
  }
  return h;
}

async function createRecord(req, res, next) {
  try {
    const { subjectSeed, sensitivePayload, recordType, status } = req.body || {};
    if (!subjectSeed || sensitivePayload === undefined) {
      return res.status(400).json({
        success: false,
        error: { message: "subjectSeed and sensitivePayload are required" },
      });
    }
    const pk = headerPk(req);
    const signer = getSigner(pk);
    const subjectHash = hashSubjectSeed(String(subjectSeed));
    const ref = await storeEncryptedPayload(sensitivePayload);
    const rec = getRecords(signer);
    const tx = await rec.createRecord(
      subjectHash,
      ref,
      recordType != null ? String(recordType) : "generic",
      status != null ? String(status) : "active"
    );
    const receipt = await tx.wait();
    const count = await rec.getRecordCount();
    res.json({
      success: true,
      data: {
        txHash: receipt.transactionHash,
        subjectHash,
        offChainReference: ref,
        recordCount: count.toString(),
      },
    });
  } catch (e) {
    next(e);
  }
}

async function getRecord(req, res, next) {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id < 1) {
      return res.status(400).json({
        success: false,
        error: { message: "invalid record id" },
      });
    }
    const pk = headerPk(req);
    const signer = getSigner(pk);
    await getRegistry(signer);
    let onChain;
    try {
      onChain = await callGetRecord(id, signer);
    } catch (err) {
      const msg = err.reason || err.error?.message || err.message || "";
      if (
        msg.includes("role not permitted") ||
        msg.includes("wrong role") ||
        msg.includes("not registered")
      ) {
        return res.status(403).json({
          success: false,
          error: {
            message:
              "unauthorised: signer cannot read on-chain record metadata (RBAC)",
          },
        });
      }
      throw err;
    }
    const ref = onChain.offChainReference;
    let decrypted = null;
    try {
      const cipher = await loadCiphertextByReference(ref);
      decrypted = decryptPayload(cipher);
    } catch (de) {
      decrypted = { error: de.message };
    }
    res.json({
      success: true,
      data: {
        recordId: onChain.recordId.toString(),
        subjectHash: onChain.subjectHash,
        offChainReference: ref,
        createdBy: onChain.createdBy,
        creatorRole: onChain.creatorRole,
        timestamp: onChain.timestamp.toString(),
        recordType: onChain.recordType,
        status: onChain.status,
        decryptedPayload: decrypted,
      },
    });
  } catch (e) {
    next(e);
  }
}

async function getRecordsBySubject(req, res, next) {
  try {
    const subjectHash = normaliseSubjectHash(req.params.hash);
    const pk = headerPk(req);
    const signer = getSigner(pk);
    await getRegistry(signer);
    let ids;
    try {
      ids = await callGetRecordsBySubjectHash(subjectHash, signer);
    } catch (err) {
      const msg = err.reason || err.error?.message || err.message || "";
      if (
        msg.includes("role not permitted") ||
        msg.includes("wrong role") ||
        msg.includes("not registered")
      ) {
        return res.status(403).json({
          success: false,
          error: { message: "unauthorised subject listing (RBAC)" },
        });
      }
      throw err;
    }
    res.json({
      success: true,
      data: { subjectHash, recordIds: ids.map((x) => x.toString()) },
    });
  } catch (e) {
    next(e);
  }
}

async function updateStatus(req, res, next) {
  try {
    const id = Number(req.params.id);
    const { status } = req.body || {};
    if (!Number.isFinite(id) || id < 1 || status === undefined) {
      return res.status(400).json({
        success: false,
        error: { message: "valid id and status required" },
      });
    }
    const pk = headerPk(req);
    const signer = getSigner(pk);
    const rec = getRecords(signer);
    const tx = await rec.updateRecordStatus(id, String(status));
    const receipt = await tx.wait();
    res.json({
      success: true,
      data: { txHash: receipt.transactionHash, recordId: id, status },
    });
  } catch (e) {
    next(e);
  }
}

module.exports = {
  createRecord,
  getRecord,
  getRecordsBySubject,
  updateStatus,
};
