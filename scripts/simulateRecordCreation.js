const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const { getSigner, getRegistry, getRecords } = require("../backend/src/services/blockchain.service");
const { storeEncryptedPayload } = require("../backend/src/services/storage.service");
const { hashSubjectSeed } = require("../backend/src/utils/subjectHash");

const CONFIG = {
  totalRecords: 200,
  unauthorizedEvery: 20,
  txDelayMs: 75,
  onChainSizeEstimateBytes: 122, // fixed metadata estimate (100-150 bytes target)
  outputDir: path.join(__dirname, "..", "simulation_results"),
  recordCsv: path.join(__dirname, "..", "simulation_results", "record_creation_results.csv"),
  unauthorizedCsv: path.join(__dirname, "..", "simulation_results", "unauthorized_attempts.csv"),
  role: {
    ADMIN: 0,
    TOURIST: 1,
    HOTEL: 2,
    HEALTH_AUTHORITY: 3,
    TOURISM_AUTHORITY: 4,
  },
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function writeCsv(filePath, header, rows) {
  const out = [header, ...rows].join("\n");
  fs.writeFileSync(filePath, out, "utf8");
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function makePayload(recordIndex) {
  const touristId = `tourist_${String(randomInt(1, 999)).padStart(3, "0")}`;
  const hotelId = `hotel_${String(randomInt(1, 30)).padStart(2, "0")}`;
  const room = String(randomInt(100, 599));
  const payload = {
    subject: touristId,
    hotel: hotelId,
    room,
    timestamp: new Date().toISOString(),
    recordType: "hotel_visit",
    status: "active",
    visitLogs: [
      { at: new Date().toISOString(), event: "checkin" },
      { at: new Date(Date.now() + 15 * 60 * 1000).toISOString(), event: "elevator" },
      { at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(), event: "checkout" },
    ],
    healthNotes: `synthetic-note-${recordIndex}-${"x".repeat(170)}`,
  };
  const size = Buffer.byteLength(JSON.stringify(payload), "utf8");
  return { payload, size };
}

async function resolveRegisteredActors() {
  let adminSigner = getSigner();
  const provider = adminSigner.provider;
  const accounts = await provider.listAccounts();
  if (!accounts.length) {
    throw new Error("No unlocked Ganache accounts found.");
  }

  // If configured signer is unfunded on this Ganache instance, fallback to unlocked account[0].
  try {
    const bal = await adminSigner.getBalance();
    if (bal.lt(ethers.utils.parseEther("0.02"))) {
      adminSigner = provider.getSigner(accounts[0]);
      console.log(
        "Configured SIGNER_PRIVATE_KEY has low balance on current chain; using unlocked Ganache admin account[0]."
      );
    }
  } catch (_) {
    adminSigner = provider.getSigner(accounts[0]);
    console.log("Using unlocked Ganache admin account[0].");
  }

  const registry = getRegistry(adminSigner);

  const hotels = [];
  const tourists = [];
  const healthAuthorities = [];

  for (const addr of accounts) {
    try {
      const registered = await registry.isRegistered(addr);
      if (!registered) continue;
      const role = Number(await registry.getRole(addr));
      if (role === CONFIG.role.HOTEL) hotels.push({ address: addr, signer: provider.getSigner(addr) });
      else if (role === CONFIG.role.TOURIST) tourists.push({ address: addr, signer: provider.getSigner(addr) });
      else if (role === CONFIG.role.HEALTH_AUTHORITY) healthAuthorities.push({ address: addr, signer: provider.getSigner(addr) });
    } catch (_) {
      // Ignore non-queryable addresses and continue.
    }
  }

  // Fallback bootstrap for simulation only: if hotels/tourists are unavailable among unlocked
  // accounts, create and register dedicated actors so the workload can run.
  if (!hotels.length || !tourists.length) {
    console.log(
      "No sufficient registered Hotel/Tourist in unlocked accounts. Bootstrapping simulation actors..."
    );

    const bootstrapActors = [
      { role: CONFIG.role.HOTEL, count: 3, prefix: "sim-hotel" },
      { role: CONFIG.role.TOURIST, count: 3, prefix: "sim-tourist" },
      { role: CONFIG.role.HEALTH_AUTHORITY, count: 1, prefix: "sim-health" },
    ];

    for (const group of bootstrapActors) {
      for (let i = 1; i <= group.count; i++) {
        const wallet = ethers.Wallet.createRandom().connect(provider);
        // Fund actor wallet for tx gas.
        const fundTx = await adminSigner.sendTransaction({
          to: wallet.address,
          value: ethers.utils.parseEther("0.25"),
        });
        await fundTx.wait();

        try {
          const regTx = await registry.registerParticipant(
            wallet.address,
            group.role,
            `${group.prefix}-${i}`
          );
          await regTx.wait();
        } catch (e) {
          // Allow already registered edge-case and continue.
          const msg = e && e.message ? e.message : "";
          if (!msg.includes("already registered")) {
            throw e;
          }
        }

        const actor = { address: wallet.address, signer: wallet };
        if (group.role === CONFIG.role.HOTEL) hotels.push(actor);
        else if (group.role === CONFIG.role.TOURIST) tourists.push(actor);
        else if (group.role === CONFIG.role.HEALTH_AUTHORITY) healthAuthorities.push(actor);
      }
    }
  }

  return { adminSigner, provider, hotels, tourists, healthAuthorities };
}

async function createRecordAsHotel(recordsContract, hotelSigner, subjectHash, offChainReference) {
  const started = Date.now();
  const tx = await recordsContract
    .connect(hotelSigner)
    .createRecord(subjectHash, offChainReference, "hotel_visit", "active");
  const receipt = await tx.wait();
  const ended = Date.now();

  return {
    gasUsed: receipt.gasUsed ? receipt.gasUsed.toString() : "",
    timeTakenMs: ended - started,
    txHash: tx.hash || "",
    status: "success",
  };
}

async function unauthorizedAttempt(recordsContract, touristSigner, subjectHash, offChainReference) {
  const started = Date.now();
  try {
    const tx = await recordsContract
      .connect(touristSigner)
      .createRecord(subjectHash, offChainReference, "hotel_visit", "active", {
        gasLimit: 500000,
      });
    const receipt = await tx.wait();
    const ended = Date.now();

    if (Number(receipt.status) === 0) {
      return {
        gasUsed: receipt.gasUsed ? receipt.gasUsed.toString() : "",
        timeTakenMs: ended - started,
        status: "reverted",
        error: "Transaction reverted (status=0)",
      };
    }

    return {
      gasUsed: receipt.gasUsed ? receipt.gasUsed.toString() : "",
      timeTakenMs: ended - started,
      status: "unexpected_success",
      error: "Tourist createRecord unexpectedly succeeded",
    };
  } catch (error) {
    const ended = Date.now();
    const gasUsed =
      error && error.receipt && error.receipt.gasUsed
        ? error.receipt.gasUsed.toString()
        : "";
    return {
      gasUsed,
      timeTakenMs: ended - started,
      status: "reverted",
      error: (error && error.message ? error.message : String(error)).slice(0, 500),
    };
  }
}

async function run() {
  const { adminSigner, hotels, tourists } = await resolveRegisteredActors();
  const recordsContract = getRecords(adminSigner);

  if (!hotels.length) {
    throw new Error("No registered Hotel accounts found among unlocked Ganache accounts.");
  }

  const recordRows = [];
  const unauthorizedRows = [];

  console.log("Record creation simulation started.");
  console.log(`Target records: ${CONFIG.totalRecords}`);
  console.log(`Registered hotels available: ${hotels.length}`);
  console.log(`Registered tourists available: ${tourists.length}`);

  for (let i = 1; i <= CONFIG.totalRecords; i++) {
    const hotelActor = pickRandom(hotels);
    const hotelSigner = hotelActor.signer;

    const { payload, size } = makePayload(i);
    const offChainReference = await storeEncryptedPayload(payload);
    const subjectHash = hashSubjectSeed(payload.subject);

    const result = {
      recordIndex: i,
      role: "Hotel",
      gasUsed: "",
      "timeTaken(ms)": "",
      offChainSize: size,
      onChainSize: CONFIG.onChainSizeEstimateBytes,
      txHash: "",
      status: "failed",
    };

    try {
      const txRes = await createRecordAsHotel(
        recordsContract,
        hotelSigner,
        subjectHash,
        offChainReference
      );
      result.gasUsed = txRes.gasUsed;
      result["timeTaken(ms)"] = txRes.timeTakenMs;
      result.txHash = txRes.txHash;
      result.status = txRes.status;
    } catch (error) {
      result.status = "failed";
      result.txHash = "";
    }

    recordRows.push(result);

    // Unauthorized check every N records.
    if (i % CONFIG.unauthorizedEvery === 0) {
      const attempt = {
        attemptIndex: i / CONFIG.unauthorizedEvery,
        role: "Tourist",
        gasUsed: "",
        error: "No registered tourist available",
        status: "skipped",
      };

      if (tourists.length) {
        const touristActor = pickRandom(tourists);
        const touristSigner = touristActor.signer;
        const badPayload = makePayload(`unauth-${i}`).payload;
        const badRef = await storeEncryptedPayload(badPayload);
        const badHash = hashSubjectSeed(badPayload.subject);

        const badRes = await unauthorizedAttempt(
          recordsContract,
          touristSigner,
          badHash,
          badRef
        );
        attempt.gasUsed = badRes.gasUsed;
        attempt.error = badRes.error;
        attempt.status = badRes.status;
      }

      unauthorizedRows.push(attempt);
    }

    if (i % 20 === 0 || i % 50 === 0) {
      console.log(`Created ${i} records...`);
    }

    if (CONFIG.txDelayMs > 0) {
      await sleep(CONFIG.txDelayMs);
    }
  }

  fs.mkdirSync(CONFIG.outputDir, { recursive: true });

  const recordHeader =
    "recordIndex,role,gasUsed,timeTaken(ms),offChainSize,onChainSize,txHash,status";
  writeCsv(
    CONFIG.recordCsv,
    recordHeader,
    recordRows.map((r) =>
      [
        r.recordIndex,
        r.role,
        r.gasUsed,
        r["timeTaken(ms)"],
        r.offChainSize,
        r.onChainSize,
        r.txHash,
        r.status,
      ]
        .map(csvEscape)
        .join(",")
    )
  );

  const unauthHeader = "attemptIndex,role,gasUsed,error,status";
  writeCsv(
    CONFIG.unauthorizedCsv,
    unauthHeader,
    unauthorizedRows.map((r) =>
      [r.attemptIndex, r.role, r.gasUsed, r.error, r.status].map(csvEscape).join(",")
    )
  );

  const successRows = recordRows.filter((r) => r.status === "success");
  const failedRows = recordRows.filter((r) => r.status !== "success");
  const avgGas =
    successRows.length > 0
      ? successRows.reduce((s, r) => s + Number(r.gasUsed || 0), 0) / successRows.length
      : 0;
  const avgTime =
    successRows.length > 0
      ? successRows.reduce((s, r) => s + Number(r["timeTaken(ms)"] || 0), 0) / successRows.length
      : 0;
  const totalOffChain = recordRows.reduce((s, r) => s + Number(r.offChainSize || 0), 0);
  const totalOnChain = recordRows.reduce((s, r) => s + Number(r.onChainSize || 0), 0);
  const storageReduction =
    totalOffChain + totalOnChain > 0
      ? (totalOffChain / (totalOffChain + totalOnChain)) * 100
      : 0;

  const unauthReverted = unauthorizedRows.filter((r) => r.status === "reverted").length;
  const unauthUnexpected = unauthorizedRows.filter((r) => r.status === "unexpected_success").length;

  console.log("\nSimulation complete.");
  console.log(`Total records: ${CONFIG.totalRecords}`);
  console.log(`Successful records: ${successRows.length}`);
  console.log(`Failed records: ${failedRows.length}`);
  console.log(`Average gas (createRecord): ${avgGas.toFixed(2)}`);
  console.log(`Average time: ${avgTime.toFixed(2)} ms`);
  console.log(`Total off-chain size: ${totalOffChain} bytes`);
  console.log(`Total on-chain size: ${totalOnChain} bytes`);
  console.log(`Storage reduction %: ${storageReduction.toFixed(2)}%`);
  console.log(
    `Unauthorized attempts -> reverted: ${unauthReverted}, unexpected success: ${unauthUnexpected}`
  );
  console.log(`Saved: ${CONFIG.recordCsv}`);
  console.log(`Saved: ${CONFIG.unauthorizedCsv}`);
}

run().catch((error) => {
  console.error("Record creation simulation failed to start:", error.message);
  process.exit(1);
});
