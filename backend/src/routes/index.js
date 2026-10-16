const express = require("express");
const { health } = require("../controllers/health.controller");
const c = require("../controllers/records.controller");

const router = express.Router();
router.get("/health", health);
router.get("/participants/:address", c.participant);
router.post("/records/prepare", c.prepareVenueRecord);
router.post("/diagnoses/prepare", c.prepareDiagnosis);
router.post("/records/:id/release", c.release);
router.post("/diagnoses/match", c.matchForDiagnosis);
router.post("/pseudonyms/self", c.ownPseudonyms);
router.post("/consent/withdrawn", c.consentWithdrawn);
router.get("/audit/verify", c.auditVerify);
module.exports = router;
