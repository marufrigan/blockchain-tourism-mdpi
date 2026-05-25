const {
  getSigner,
  getRegistry,
} = require("../services/blockchain.service");

function headerPk(req) {
  const h = req.headers["x-signer-private-key"];
  return typeof h === "string" && h.length > 0 ? h.trim() : null;
}

async function register(req, res, next) {
  try {
    const { address, role, nameOrLabel } = req.body || {};
    if (!address || role === undefined || role === null) {
      return res.status(400).json({
        success: false,
        error: { message: "address and role are required" },
      });
    }
    const pk = headerPk(req);
    const signer = getSigner(pk);
    const reg = getRegistry(signer);
    const tx = await reg.registerParticipant(
      address,
      Number(role),
      nameOrLabel != null ? String(nameOrLabel) : ""
    );
    const receipt = await tx.wait();
    res.json({
      success: true,
      data: {
        txHash: receipt.transactionHash,
        address,
        role: Number(role),
      },
    });
  } catch (e) {
    next(e);
  }
}

async function getParticipant(req, res, next) {
  try {
    const addr = req.params.address;
    if (!addr) {
      return res.status(400).json({
        success: false,
        error: { message: "address required" },
      });
    }
    const pk = headerPk(req);
    const signer = getSigner(pk);
    const reg = getRegistry(signer);
    const p = await reg.getParticipant(addr);
    res.json({
      success: true,
      data: {
        address: addr,
        registered: p[0],
        role: p[1],
        nameOrLabel: p[2],
      },
    });
  } catch (e) {
    next(e);
  }
}

module.exports = { register, getParticipant };
