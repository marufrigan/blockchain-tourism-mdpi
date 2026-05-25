const ParticipantRegistry = artifacts.require("ParticipantRegistry");
const ContactRecordManager = artifacts.require("ContactRecordManager");

contract("PCTF — ParticipantRegistry & ContactRecordManager", (accounts) => {
  const [
    admin,
    tourist,
    hotel,
    health,
    tourism,
    outsider,
  ] = accounts;

  const ROLE_ADMIN = 0;
  const ROLE_TOURIST = 1;
  const ROLE_HOTEL = 2;
  const ROLE_HEALTH = 3;
  const ROLE_TOURISM = 4;

  let registry;
  let records;

  before(async () => {
    registry = await ParticipantRegistry.deployed();
    records = await ContactRecordManager.deployed();
  });

  it("1. participant registration works (admin registers stakeholders)", async () => {
    await registry.registerParticipant(tourist, ROLE_TOURIST, "tourist-demo", {
      from: admin,
    });
    await registry.registerParticipant(hotel, ROLE_HOTEL, "hotel-demo", {
      from: admin,
    });
    await registry.registerParticipant(health, ROLE_HEALTH, "health-demo", {
      from: admin,
    });
    await registry.registerParticipant(tourism, ROLE_TOURISM, "tourism-demo", {
      from: admin,
    });

    const t = await registry.getParticipant(tourist);
    assert.equal(t[0], true);
    assert.equal(t[1], ROLE_TOURIST);
  });

  it("2. duplicate registration is rejected", async () => {
    try {
      await registry.registerParticipant(tourist, ROLE_TOURIST, "dup", {
        from: admin,
      });
      assert.fail("expected revert");
    } catch (e) {
      assert(
        e.message.includes("already registered") ||
          e.message.includes("revert"),
        e.message
      );
    }
  });

  it("3. role retrieval works", async () => {
    const r = await registry.getRole(hotel);
    assert.equal(r, ROLE_HOTEL);
    const reg = await registry.isRegistered(health);
    assert.equal(reg, true);
  });

  it("4. unauthorised role cannot register participants", async () => {
    try {
      await registry.registerParticipant(outsider, ROLE_TOURIST, "x", {
        from: hotel,
      });
      assert.fail("expected revert");
    } catch (e) {
      assert(
        e.message.includes("only admin") || e.message.includes("revert"),
        e.message
      );
    }
  });

  it("5. authorised role can create record", async () => {
    const subjectHash = web3.utils.keccak256("subject-alpha");
    const ref = "local:demo-ref-1";
    const tx = await records.createRecord(
      subjectHash,
      ref,
      "hotel_visit",
      "active",
      { from: hotel }
    );
    assert.ok(tx.receipt.status);
  });

  it("6. record count increments", async () => {
    const c = await records.getRecordCount();
    assert.equal(c.toString(), "1");
  });

  it("7. record retrieval works for authorised reader", async () => {
    const rec = await records.getRecord(1, { from: health });
    assert.equal(rec.recordId.toString(), "1");
    assert.equal(rec.offChainReference, "local:demo-ref-1");
    assert.equal(rec.status, "active");
  });

  it("8. status update restrictions — tourist cannot update", async () => {
    try {
      await records.updateRecordStatus(1, "closed", { from: tourist });
      assert.fail("expected revert");
    } catch (e) {
      assert(
        e.message.includes("role not permitted") ||
          e.message.includes("revert"),
        e.message
      );
    }
  });

  it("9. authorised status update succeeds", async () => {
    await records.updateRecordStatus(1, "verified", { from: health });
    const rec = await records.getRecord(1, { from: tourism });
    assert.equal(rec.status, "verified");
  });

  it("10. events — ParticipantRegistered and ContactRecordCreated", async () => {
    const newAddr = outsider;
    const txReg = await registry.registerParticipant(
      newAddr,
      ROLE_HOTEL,
      "event-hotel",
      { from: admin }
    );
    const participantLog = txReg.logs.find(
      (l) => l.event === "ParticipantRegistered"
    );
    assert.ok(participantLog, "ParticipantRegistered event missing");

    const subjectHash = web3.utils.keccak256("subject-beta");
    const txRec = await records.createRecord(
      subjectHash,
      "ref-beta",
      "health_note",
      "pending",
      { from: newAddr }
    );
    const createdLog = txRec.logs.find(
      (l) => l.event === "ContactRecordCreated"
    );
    assert.ok(createdLog, "ContactRecordCreated event missing");

    const txUp = await records.updateRecordStatus(2, "archived", {
      from: newAddr,
    });
    const statusLog = txUp.logs.find(
      (l) => l.event === "ContactRecordStatusUpdated"
    );
    assert.ok(statusLog, "ContactRecordStatusUpdated event missing");
  });

  it("tourist cannot read on-chain record (prototype privacy boundary)", async () => {
    try {
      await records.getRecord(1, { from: tourist });
      assert.fail("expected revert");
    } catch (e) {
      assert(
        e.message.includes("role not permitted") ||
          e.message.includes("revert"),
        e.message
      );
    }
  });

  it("getRecordsBySubjectHash returns ids", async () => {
    const h = web3.utils.keccak256("subject-alpha");
    const ids = await records.getRecordsBySubjectHash(h, { from: admin });
    assert.equal(ids.length, 1);
    assert.equal(ids[0].toString(), "1");
  });
});
