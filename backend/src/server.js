const path = require("path");
const express = require("express");
const cors = require("cors");
const config = require("./config");
const routes = require("./routes");
const { errorHandler } = require("./middleware/errorHandler");

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use("/api", routes);

app.get("/", (_req, res) => {
  res.json({
    success: true,
    data: {
      name: "PCTF backend",
      api: "/api",
      health: "/api/health",
    },
  });
});

app.use(errorHandler);

app.listen(config.port, () => {
  console.log(`PCTF backend http://127.0.0.1:${config.port}`);
  console.log(`RPC ${config.rpcUrl} | storage=${config.storageMode}`);
  console.log(`.env loaded from ${path.join(config.projectRoot, ".env")}`);
});
