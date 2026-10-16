const { getContext } = require("../services/context");
const { encryptPayload } = require("../utils/crypto");
const { subjectPseudonym, venuePseudonym, epochOf } = require("../utils/pseudonym");
const { matchExposures } = require("../services/exposure.service");
const { ROLE } = require("../services/keyRelease.service");

function authFrom(body, target) {
  const { address, ts, nonce, signature } = body.auth || {};
  return { claimedAddress: address, ts, nonce, signature, target: String(target) };
}

async function requireRole(ctx, auth, action, role) {
  const who = ctx.krs.authenticate({ ...auth, action });
  const [active, r] = await ctx.registry.roleOf(who);
  if (!active || Number(r) !== role) {
    const e = new Error("forbidden for this role");
    e.status = 403;
    throw e;
  }
  return who;
}

/** Hotel: encrypt and store a venue check-in, return the values for createVenueRecord. */
async function prepareVenueRecord(req, res, next) {
  try {
    const ctx = getContext();
    const { subjectId, venueId, tStart, tEnd, payload, touristAddress, ttl = 0 } = req.body || {};
    if (!subjectId || !venueId || tStart === undefined || tEnd === undefined || payload === undefined) {
      return res.status(400).json({ success: false, error: { message: "subjectId, venueId, tStart, tEnd, payload required" } });
    }
    await requireRole(ctx, authFrom(req.body, venueId), "prepare-venue", ROLE.HOTEL);
    const { ciphertext, dek } = encryptPayload(payload);
    const put = await ctx.storage.put(ciphertext);
    ctx.keystore.put(put.digest, dek, { owner: touristAddress || null, expiresAt: ttl ? Number(tEnd) + Number(ttl) : 0 });
    res.json({
      success: true,
      data: {
        subjectHash: subjectPseudonym(ctx.pepper, subjectId, epochOf(tStart)),
        venueHash: venuePseudonym(ctx.pepper, venueId),
        contentDigest: put.digest,
        storageScheme: put.scheme,
        offChainReference: put.ref,
        next: "call ContactRecordManager.createVenueRecord from the hotel wallet",
      },
    });
  } catch (e) {
    next(e);
  }
}

/** Health authority: encrypt and store a diagnostic record. */
async function prepareDiagnosis(req, res, next) {
  try {
    const ctx = getContext();
    const { subjectId, tDiagnosis, payload, touristAddress } = req.body || {};
    await requireRole(ctx, authFrom(req.body, subjectId), "prepare-diagnosis", ROLE.HEALTH);
    const { ciphertext, dek } = encryptPayload(payload);
    const put = await ctx.storage.put(ciphertext);
    ctx.keystore.put(put.digest, dek, { owner: touristAddress || null });
    res.json({
      success: true,
      data: { subjectHash: subjectPseudonym(ctx.pepper, subjectId, epochOf(tDiagnosis)), contentDigest: put.digest, storageScheme: put.scheme },
    });
  } catch (e) {
    next(e);
  }
}

/** Any role: request decryption of one record (Algorithm 4). */
async function release(req, res, next) {
  try {
    const out = await getContext().krs.release(authFrom(req.body, req.params.id));
    res.json({ success: true, data: out });
  } catch (e) {
    next(e);
  }
}

/** Health authority: compute exposures for a diagnosis (Algorithm 3, step 2). */
async function matchForDiagnosis(req, res, next) {
  try {
    const ctx = getContext();
    const { subjectId, tFrom, tTo, maxStaySec = 3 * 86400 } = req.body || {};
    const auth = authFrom(req.body, subjectId);
    // look back by the maximum stay length: a stay that began before the window has an earlier pseudonym
    const pseud = await ctx.krs.pseudonymsForDiagnosis(auth, subjectId, Number(tFrom) - Number(maxStaySec), tTo);
    const crm = ctx.crm.connect(new (require("ethers").VoidSigner)(auth.claimedAddress, ctx.provider));
    const m = await matchExposures(crm, pseud, tFrom, tTo);
    res.json({ success: true, data: { ...m, next: "call notifyExposures(diagnosisId, exposed) in batches of <= 100" } });
  } catch (e) {
    next(e);
  }
}

/** Tourist: own pseudonyms for checking exposure status on-chain. */
async function ownPseudonyms(req, res, next) {
  try {
    const { fromTs, toTs } = req.body || {};
    const list = await getContext().krs.ownPseudonyms(authFrom(req.body, "self"), fromTs, toTs);
    res.json({ success: true, data: { pseudonyms: list } });
  } catch (e) {
    next(e);
  }
}

/** Tourist: after setConsent(false) on-chain, shred all linked objects. */
async function consentWithdrawn(req, res, next) {
  try {
    const ctx = getContext();
    const who = await requireRole(ctx, authFrom(req.body, "consent"), "consent-withdrawn", ROLE.TOURIST);
    if (await ctx.crm.consentGiven(who)) return res.status(409).json({ success: false, error: { message: "consent still recorded on-chain" } });
    res.json({ success: true, data: { shredded: ctx.krs.onConsentWithdrawn(who) } });
  } catch (e) {
    next(e);
  }
}

async function auditVerify(_req, res, next) {
  try {
    res.json({ success: true, data: getContext().audit.verify() });
  } catch (e) {
    next(e);
  }
}

async function participant(req, res, next) {
  try {
    const p = await getContext().registry.getParticipant(req.params.address);
    res.json({ success: true, data: { registered: p.registered, active: p.active, role: p.role, label: p.label } });
  } catch (e) {
    next(e);
  }
}

module.exports = { prepareVenueRecord, prepareDiagnosis, release, matchForDiagnosis, ownPseudonyms, consentWithdrawn, auditVerify, participant };
