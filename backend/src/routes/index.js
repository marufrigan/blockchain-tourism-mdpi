const express = require("express");
const { health } = require("../controllers/health.controller");
const participants = require("../controllers/participants.controller");
const records = require("../controllers/records.controller");
const utils = require("../controllers/utils.controller");

const router = express.Router();

router.get("/health", health);

router.post("/participants/register", participants.register);
router.get("/participants/:address", participants.getParticipant);

router.post("/records", records.createRecord);
router.get("/records/:id", records.getRecord);
router.get("/subjects/:hash/records", records.getRecordsBySubject);
router.patch("/records/:id/status", records.updateStatus);

router.post("/utils/hash-subject", utils.hashSubject);
router.post("/utils/encrypt", utils.encrypt);
router.post("/utils/decrypt", utils.decrypt);

module.exports = router;
