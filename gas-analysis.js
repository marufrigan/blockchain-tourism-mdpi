#!/usr/bin/env node
/**
 * Run from project root: node gas-analysis.js
 * Requires: Ganache (or compatible JSON-RPC) and migrated contracts; see scripts/gas-analysis/gas-analysis.mjs
 */
const { spawnSync } = require("child_process");
const path = require("path");

const r = spawnSync(
  process.execPath,
  [path.join(__dirname, "scripts/gas-analysis/gas-analysis.mjs")],
  { stdio: "inherit", env: process.env, cwd: __dirname }
);
process.exit(r.status === null ? 1 : r.status);
