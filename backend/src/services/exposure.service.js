/**
 * Exposure matching (Algorithm 3, step 2). Runs for an authenticated Health Authority.
 * Inputs are only on-chain data plus the diagnosed subject's epoch pseudonyms released by the
 * key service, so any auditor holding the same inputs can re-run the match and get the same set.
 */
/**
 * Matching rule. Stays and windows are closed intervals [a, b] of integer seconds.
 * The signed overlap of [a, b] and [c, d] is ell = min(b, d) - max(a, c); it is negative exactly
 * when the intervals are disjoint. Two intervals match when ell >= theta with theta >= 0.
 * theta = 0 (the default) means a non-empty intersection, so contact at a single endpoint
 * (one checks out at the second the other checks in) counts. theta > 0 asks for a minimum
 * shared duration in seconds. An empty clipped interval (a visit outside the window) never matches.
 */
function signedOverlap(aStart, aEnd, bStart, bEnd) {
  return Math.min(Number(aEnd), Number(bEnd)) - Math.max(Number(aStart), Number(bStart));
}

function overlaps(aStart, aEnd, bStart, bEnd, theta = 0) {
  return signedOverlap(aStart, aEnd, bStart, bEnd) >= theta;
}

async function readAll(fn, key, page = 500) {
  const out = [];
  for (let start = 0; ; start += page) {
    const ids = await fn(key, start, page);
    out.push(...ids.map((x) => Number(x)));
    if (ids.length < page) break;
  }
  return out;
}

/**
 * @param crm contract connected to the health authority signer
 * @param diagPseudonyms pseudonyms of the diagnosed subject over the infectious window
 * @param tFrom,tTo infectious window [t_d - w, t_d]
 * @param theta minimum shared duration in seconds (0 = non-empty intersection)
 * @returns {{exposed: string[], sourceVisits: number, scanned: number}}
 */
async function matchExposures(crm, diagPseudonyms, tFrom, tTo, theta = 0) {
  const cache = new Map();
  const get = async (id) => {
    if (!cache.has(id)) cache.set(id, await crm.getRecord(id));
    return cache.get(id);
  };
  const own = new Set(diagPseudonyms.map((p) => p.toLowerCase()));
  const visits = [];
  for (const p of diagPseudonyms) {
    const ids = await readAll((k, s, m) => crm.getSubjectRecordIds(k, s, m), p);
    for (const id of ids) {
      const r = await get(id);
      // keep source visits whose clipped interval [max(tStart, tFrom), min(tEnd, tTo)] is non-empty
      if (Number(r.dataType) === 1 && Number(r.status) === 0 && overlaps(r.tStart, r.tEnd, tFrom, tTo)) visits.push(r);
    }
  }
  const exposed = new Set();
  let scanned = 0;
  for (const v of visits) {
    const ids = await readAll((k, s, m) => crm.getVenueRecordIds(k, s, m), v.venueHash);
    for (const id of ids) {
      const r = await get(id);
      scanned++;
      if (Number(r.status) !== 0) continue;
      const subj = r.subjectHash.toLowerCase();
      if (own.has(subj)) continue;
      const vs = Math.max(Number(v.tStart), Number(tFrom));
      const ve = Math.min(Number(v.tEnd), Number(tTo));
      if (overlaps(r.tStart, r.tEnd, vs, ve, theta)) exposed.add(subj);
    }
  }
  return { exposed: [...exposed], sourceVisits: visits.length, scanned };
}

module.exports = { matchExposures, overlaps, signedOverlap };
