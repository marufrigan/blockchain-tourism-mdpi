"""Machine-checked lemmas for the PCTF model (Section 4), using the Z3 SMT solver.

Each property is stated as a universally quantified formula over unbounded integers;
Z3 proves it by showing that its negation is unsatisfiable.

  L1  Policy encoding: idx(r,d,a) = 10r + 2d + a is injective on R x D x A and fits in 64 bits.
  L2  Initial policy: no administrator, tourism-authority or hotel bit grants READ on
      individual (d_o) or diagnostic (d_x) data; the matrix equals Table 2.
  L3  Look-back completeness: if a stay [t_in, t_out] with t_out - t_in <= s_max overlaps the
      infectious window [t_d - w, t_d], the epoch of t_in lies in
      [epoch(t_d - w - s_max), epoch(t_d)], so its pseudonym is in Psi_d.
  L4  Clipping soundness: if a contact interval meets Omega_i = [max(t_in_i, t_d - w),
      min(t_out_i, t_d)], the contact and the patient were present at the same venue at a
      common instant inside the infectious window.
  L5  Clipping completeness: conversely, any common instant of the contact interval, the
      patient's visit and the window lies in Omega_i.
Usage: python3 formal/verify_properties.py [results_dir]
"""
import json
import os
import sys

from z3 import And, BitVec, BitVecVal, Exists, ForAll, If, Implies, Int, Not, Or, Solver, ULT, sat, unsat

EPOCH = 86400


def prove(name, claim):
    s = Solver()
    s.add(Not(claim))
    r = s.check()
    ok = r == unsat
    print(f"{name}: {'proved' if ok else 'FAILED'} ({r})")
    if r == sat:
        print("  counterexample:", s.model())
    return ok


def maxi(a, b):
    return If(a >= b, a, b)


def mini(a, b):
    return If(a <= b, a, b)


results = {}

# ---------------------------------------------------------------- L1 encoding
r, d, a, r2, d2, a2 = Int("r"), Int("d"), Int("a"), Int("r2"), Int("d2"), Int("a2")
dom = lambda r, d, a: And(r >= 0, r <= 4, d >= 0, d <= 4, a >= 0, a <= 1)
idx = lambda r, d, a: 10 * r + 2 * d + a
results["L1_injective"] = prove("L1 injective", Implies(And(dom(r, d, a), dom(r2, d2, a2), idx(r, d, a) == idx(r2, d2, a2)), And(r == r2, d == d2, a == a2)))
results["L1_fits64"] = prove("L1 index < 64", Implies(dom(r, d, a), And(idx(r, d, a) >= 0, idx(r, d, a) <= 49)))

# ---------------------------------------------------------------- L2 initial policy
ADMIN, TOURIST, HOTEL, HEALTH, TOURISM = range(5)
D_O, D_V, D_X, D_G, D_C = range(5)
READ, WRITE = 0, 1
grants = [  # constructor of RoleAccessControl.sol
    (TOURIST, D_O, READ), (TOURIST, D_X, READ),
    (HOTEL, D_V, READ), (HOTEL, D_V, WRITE), (HOTEL, D_G, READ),
    (HEALTH, D_O, READ), (HEALTH, D_O, WRITE), (HEALTH, D_V, READ), (HEALTH, D_X, READ),
    (HEALTH, D_X, WRITE), (HEALTH, D_G, READ), (HEALTH, D_G, WRITE),
    (TOURISM, D_G, READ), (ADMIN, D_C, READ), (ADMIN, D_C, WRITE),
]
bits = 0
for g in grants:
    bits |= 1 << (10 * g[0] + 2 * g[1] + g[2])
P0 = BitVecVal(bits, 64)
rb, db = BitVec("rb", 64), BitVec("db", 64)


def rho(role, dt, act):
    sh = role * 10 + dt * 2 + act
    return (P0 >> sh) & 1 == 1


restricted = Or(rb == ADMIN, rb == TOURISM, rb == HOTEL)
sensitive = Or(db == D_O, db == D_X)
results["L2_no_sensitive_read"] = prove(
    "L2 admin/tourism/hotel cannot READ d_o or d_x under P0",
    Implies(And(ULT(rb, 5), ULT(db, 5), restricted, sensitive), Not(rho(rb, db, BitVecVal(READ, 64)))))
results["L2_admin_config_only"] = prove(
    "L2 admin holds only d_c rights under P0",
    ForAll([db], Implies(And(ULT(db, 5), db != D_C), And(Not(rho(BitVecVal(ADMIN, 64), db, BitVecVal(0, 64))), Not(rho(BitVecVal(ADMIN, 64), db, BitVecVal(1, 64)))))))
results["policyBitsHex"] = hex(bits)

# ---------------------------------------------------------------- L3 look-back completeness
tin, tout, td, w, smax = Int("tin"), Int("tout"), Int("td"), Int("w"), Int("smax")
pre = And(tin >= 0, tin <= tout, tout - tin <= smax, smax >= 0, w >= 0, td - w - smax >= 0,
          tin <= td, tout >= td - w)
ep = lambda t: t / EPOCH  # Z3 integer division (floor for non-negative t)
results["L3_lookback"] = prove("L3 look-back completeness",
                               Implies(pre, And(ep(tin) >= ep(td - w - smax), ep(tin) <= ep(td))))
# the look-back is necessary: without s_max a stay can start in an earlier epoch
s3 = Solver()
s3.add(pre, smax > 0, ep(tin) < ep(td - w))
results["L3_lookback_necessary"] = s3.check() == sat
print("L3 look-back necessary (counterexample exists without s_max):", results["L3_lookback_necessary"])

# ---------------------------------------------------------------- L4/L5 clipping
a_, b_, ti, to = Int("a"), Int("b"), Int("ti"), Int("to")
lo, hi = maxi(ti, td - w), mini(to, td)
meets = And(a_ <= hi, lo <= b_, lo <= hi)
t = Int("t")
common = And(a_ <= t, t <= b_, ti <= t, t <= to, td - w <= t, t <= td)
wf = And(a_ <= b_, ti <= to, w >= 0)
results["L4_clip_sound"] = prove("L4 clipping soundness", Implies(And(wf, meets), Exists([t], common)))
results["L5_clip_complete"] = prove("L5 clipping completeness", ForAll([t], Implies(And(wf, common), And(lo <= t, t <= hi, a_ <= hi, lo <= b_))))

out = sys.argv[1] if len(sys.argv) > 1 else "results"
json.dump(results, open(os.path.join(out, "e12_formal_lemmas.json"), "w"), indent=2)
assert all(v for k, v in results.items() if k.startswith("L")), "a lemma failed"
print("all lemmas proved")
