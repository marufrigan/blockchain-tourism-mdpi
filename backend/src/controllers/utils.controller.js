const { hashSubjectSeed } = require("../utils/subjectHash");
const { encryptPayload, decryptPayload } = require("../utils/crypto");

async function hashSubject(req, res, next) {
  try {
    const { subjectSeed } = req.body || {};
    if (subjectSeed === undefined || subjectSeed === null) {
      return res.status(400).json({
        success: false,
        error: { message: "subjectSeed required" },
      });
    }
    const subjectHash = hashSubjectSeed(String(subjectSeed));
    res.json({ success: true, data: { subjectSeed: String(subjectSeed), subjectHash } });
  } catch (e) {
    next(e);
  }
}

async function encrypt(req, res, next) {
  try {
    const { payload } = req.body || {};
    if (payload === undefined) {
      return res.status(400).json({
        success: false,
        error: { message: "payload required" },
      });
    }
    const ciphertext = encryptPayload(payload);
    res.json({ success: true, data: { ciphertext } });
  } catch (e) {
    next(e);
  }
}

async function decrypt(req, res, next) {
  try {
    const { ciphertext } = req.body || {};
    if (!ciphertext) {
      return res.status(400).json({
        success: false,
        error: { message: "ciphertext required" },
      });
    }
    const payload = decryptPayload(String(ciphertext));
    res.json({ success: true, data: { payload } });
  } catch (e) {
    next(e);
  }
}

module.exports = { hashSubject, encrypt, decrypt };
