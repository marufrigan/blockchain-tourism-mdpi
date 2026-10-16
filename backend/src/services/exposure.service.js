/**
 * Exposure matching (Algorithm 3, step 2). Runs for an authenticated Health Authority.
 * Inputs are only on-chain data plus the diagnosed subject's epoch pseudonyms released by the
 * key service, so any auditor holding the same inputs can re-run the match and get the same set.
 */
function overlaps(aStart, aEnd, bStart, bEnd) {
  return Number(aStart) <= Number(bEnd) && Number(bStart) <= Number(aEnd);
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
 * @returns {{exposed: string[], sourceVisits: number, scanned: number}}
 */
async function matchExposures(crm, diagPseudonyms, tFrom, tTo) {
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
      if (overlaps(r.tStart, r.tEnd, vs, ve)) exposed.add(subj);
    }
  }
  return { exposed: [...exposed], sourceVisits: visits.length, scanned };
}

module.exports = { matchExposures, overlaps };
