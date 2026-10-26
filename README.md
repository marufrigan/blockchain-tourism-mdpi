# PCTF: Privacy-preserving Contact Tracing Framework for Smart Tourism

A hybrid blockchain framework for privacy-preserving contact tracing in smart tourism, combining role-based access control with encrypted off-chain storage. This repository contains the smart contracts, the service layer, the test suite and the scripts used to evaluate the framework.

PCTF separates **integrity** from **confidentiality**:

* **On-chain (Solidity):** a role registry, a five-role access-control policy enforced on every write, and an index of venue check-ins, diagnoses, exposure notices and aggregates. Only keyed pseudonyms, content digests and times are stored.
* **Off-chain (Node.js):** envelope encryption (AES-256-GCM, one data key per record), HMAC-SHA256 pseudonyms that rotate daily, content-addressed ciphertext storage (local or IPFS raw CIDv1), a **key-release service** that authenticates requesters by EIP-191 signature and re-evaluates the on-chain policy before decrypting, exposure matching, crypto-shredding on consent withdrawal or expiry, and a hash-chained audit log.

> Access checks in Solidity `view` functions are **not** a confidentiality control: contract storage is public and the caller of `eth_call` can be spoofed. PCTF therefore never relies on them for privacy; see the last test in `test/pctf.test.js` and the security results in `results/summary.json` (`E7`).

## Repository layout

| Path | Content |
|---|---|
| `contracts/ParticipantRegistry.sol` | φ : PK → R; register, updateRole, revoke (admin only, last admin protected) |
| `contracts/RoleAccessControl.sol` | policy ρ as a 64-bit matrix, decision δ, `enforceAccess` modifier, logged `setPolicy` |
| `contracts/ContactRecordManager.sol` | venue records, diagnoses, bounded exposure notices (≤100), aggregates, consent |
| `contracts/FullOnChainRecordManager.sol` | **evaluation baseline only**: same RBAC, payload stored on-chain |
| `contracts/AclRecordManager.sol` | **evaluation baseline only**: hybrid design with per-record access lists instead of roles and a policy matrix |
| `contracts/AuditAnchor.sol` | anchors the head hash of the key-release audit log on-chain |
| `backend/src/baselines/central.service.js` | **evaluation baseline only**: centralised service with the same policy, envelope encryption and key-release code, and an Ed25519-signed audit log |
| `backend/src/services/keyRelease.service.js` | Algorithm 4 (signature auth, policy check as requester, consent, expiry, decrypt); all checks of one decision read one block, recorded in the audit entry; persistent nonce log; fails closed if the chain or the object store is unavailable |
| `backend/src/services/exposure.service.js` | Algorithm 3 exposure matching from the on-chain index; closed intervals, signed overlap `min(ends) - max(starts) >= theta` (theta = 0: non-empty intersection, endpoint contact counts) |
| `backend/src/services/storage.service.js` | content-addressed store (local / IPFS CIDv1) with digest verification |
| `backend/src/services/keystore.service.js` | wrapped per-record keys, crypto-shredding, retention purge |
| `backend/src/utils/pseudonym.js`, `crypto.js` | HMAC pseudonyms; AES-256-GCM envelope encryption |
| `test/pctf.test.js`, `test/extensions.test.js` | 21 automated tests (contracts, key release, matching rule, replay across restarts, fail-closed behaviour) |
| `scripts/experiments/run-all.js` | experiments E1–E3 and E5–E9 |
| `scripts/experiments/throughput.js` | experiment E4 (2 s block period, back-pressure of 100 unconfirmed records) |
| `scripts/experiments/extended.js` | E14 hybrid-ACL and centralised baselines, E16 scale and venue density, E17 concurrency and replay, E18 storage, chain and service failures, E20 metadata-linkage attack |
| `scripts/experiments/besu-qbft.js`, `scripts/besu/` | E15 and E19 on a four-validator Hyperledger Besu QBFT network: throughput, cross-node visibility, validator faults, revocation-to-enforcement delay |
| `scripts/figures/` | result figures from `results/` (600 dpi PNG + PDF) |
| `figures/src/` | TikZ sources of the system-model and key-release protocol figures |
| `formal/verify_properties.py` | Z3 proofs of the model lemmas (policy encoding, initial policy, look-back completeness and necessity, window clipping) |
| `formal/check_key_release.js` | exhaustive conformance check of the key-release service against the formal decision rule (1,728 cases, in-memory chain model) |
| `formal/check_key_release_onchain.js` | the same 1,728 cases against the deployed contracts, compared with the rule and with the in-memory model |
| `scripts/analysis/` | analytical gas and throughput models, exact confidence bounds, anonymity sets of the venue index |
| `results/` | raw CSV results, `summary.json`, Slither and Mythril reports |

## Requirements

Node.js ≥ 18 (tested on 22), npm, Python 3 with matplotlib (figures), and `z3-solver`, `scipy` and `numpy` for the verification scripts (`pip install z3-solver scipy numpy matplotlib`); `pdflatex` with TikZ for the two diagrams. No external blockchain is needed: the scripts start their own Ganache 7.9.2 chain.

```bash
npm install
npm run compile        # solc-js 0.8.19, optimizer 200 runs -> build/artifacts.json
npm test               # 21 tests
```

## Reproducing the results

```bash
npm run evaluate       # writes results/*.csv and results/summary.json (about 15 minutes)
npm run verify         # models, confidence bounds, Z3 lemmas, exhaustive key-release check
npm run figures        # writes figures/*.png and figures/*.pdf
node scripts/experiments/extended.js all     # E14, E16-E18, E20
```

Multi-node experiments (Hyperledger Besu 25.10.0, Java 21):

```bash
BESU=/path/to/besu/bin/besu scripts/besu/setup-qbft.sh ./besu-net    # 4 validators, 2 s blocks, prefunded test accounts
BESU=/path/to/besu/bin/besu scripts/besu/run-network.sh ./besu-net &  # RPC on 127.0.0.1:8545-8548
BESU=/path/to/besu/bin/besu node scripts/experiments/besu-qbft.js ./besu-net 1500   # stops and restarts validators 3 and 4
```

| Result | Source |
|---|---|
| Registration, records, gas | `results/e1_*.csv`, `results/e2_record_creation.csv`, `results/e2_state_trace.csv` |
| Fully on-chain baseline | `results/e3_baseline_sizes.csv`, `results/e3_baseline_workload.csv` |
| Throughput | `results/e4_throughput_2s.csv` |
| Exposure matching | `results/e5_diagnosis_matching.csv`, `results/e5_notifications.csv` |
| Access-control matrix | `results/e6_access_matrix.csv` |
| Security experiments | `results/summary.json` → `E7` |
| Key release, IPFS, static analysis | `results/e8_key_release.csv`, `results/e9_ipfs.csv`, `results/static-analysis/` |
| Anonymity sets per venue and day | `results/e10_anonymity_sets.csv` |
| Gas and throughput models, confidence bounds | `results/e11_models.json` |
| Machine-checked lemmas | `results/e12_formal_lemmas.json` |
| Key-release conformance (all 1,728 cases) | `results/e13_key_release_exhaustive.csv`, `results/e13_key_release_onchain.csv` |
| Hybrid-ACL and centralised baselines | `results/e14_governance.csv`, `results/e14_release_latency.csv`, `summary.json` → `E14` |
| Besu QBFT: writes, throughput, concurrency, faults | `results/e15_*.csv`, `summary.json` → `E15` |
| Scale and venue density | `results/e16_scale_density.csv` |
| Concurrency, replay, revocation race | `results/e17_concurrency.csv`, `summary.json` → `E17` |
| Failures (objects, store, chain, restart, backups) | `summary.json` → `E18` |
| Revocation-to-enforcement delay | `results/e19_revocation_delay.csv` |
| Metadata-linkage attack | `results/e20_linkage.csv` |

Static analysis: `slither contracts/ContactRecordManager.sol` (Slither 0.11.6) and `myth analyze contracts/ContactRecordManager.sol:ContactRecordManager --solv 0.8.19 -t 2` (Mythril 0.24.8).

## Running the REST service (demo)

```bash
cp .env.example .env   # fill KEK_HEX and PSEUDONYM_PEPPER_HEX with `openssl rand -hex 32`
npx ganache -p 7545 &  # or any EVM node
npm run deploy && npm run backend
```

Requests are authenticated with an EIP-191 signature over `PCTF|<action>|<target>|<timestamp>|<nonce>`; the service never accepts private keys. Transactions are signed by each stakeholder's own wallet.

## Erasure and key copies

Crypto-shredding only erases a record if every usable copy of its wrapped key is gone. Wrapped keys live only in `keystore.json`; the audit log and the nonce log contain decisions, digests and nonces but no key material; released plaintext is not cached. Backups and disk or VM snapshots of the key store are copies: experiment E18 restores a pre-withdrawal snapshot and shows that the shredded records become readable again. Keep the key store out of general backups (for example in an HSM), or encrypt its backups under a backup key that is destroyed when the retention period ends. Plaintext already released to a recipient is outside this mechanism.

## Data and scope

All data are synthetic. This is a proof-of-concept: production use needs a permissioned network, a distributed (threshold) key service, multi-signature administration, a data protection impact assessment and a legal basis for processing health data.

## Licence

MIT, see `LICENSE`.
