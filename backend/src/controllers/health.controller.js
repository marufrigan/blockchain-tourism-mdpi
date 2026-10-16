const config = require("../config");

function health(_req, res) {
  res.json({
    success: true,
    data: {
      service: "pctf-backend",
      rpcUrl: config.rpcUrl,
      storageMode: config.storageMode,
    },
  });
}

module.exports = { health };
