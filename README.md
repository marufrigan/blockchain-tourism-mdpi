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
| `backend/src/services/keyRelease.service.js` | Algorithm 4 (signature auth, policy check as requester, consent, expiry, decrypt) |
| `backend/src/services/exposure.service.js` | Algorithm 3 exposure matching from the on-chain index |
| `backend/src/services/storage.service.js` | content-addressed store (local / IPFS CIDv1) with digest verification |
| `backend/src/services/keystore.service.js` | wrapped per-record keys, crypto-shredding, retention purge |
| `backend/src/utils/pseudonym.js`, `crypto.js` | HMAC pseudonyms; AES-256-GCM envelope encryption |
| `test/pctf.test.js` | 12 automated tests |
| `scripts/experiments/run-all.js` | experiments E1–E3 and E5–E9 |
| `scripts/experiments/throughput.js` | experiment E4 (2 s block period, back-pressure of 100 unconfirmed records) |
| `scripts/figures/` | black-and-white figure scripts (600 dpi PNG + PDF) |
| `results/` | raw CSV results, `summary.json`, Slither and Mythril reports |

## Requirements

Node.js ≥ 18 (tested on 22), npm, Python 3 with matplotlib (figures only). No external blockchain is needed: the scripts start their own Ganache 7.9.2 chain.

```bash
npm install
npm run compile        # solc-js 0.8.19, optimizer 200 runs -> build/artifacts.json
npm test               # 12 tests
```

## Reproducing the results

```bash
npm run evaluate       # writes results/*.csv and results/summary.json (about 15 minutes)
npm run figures        # writes figures/*.png and figures/*.pdf
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

Static analysis: `slither contracts/ContactRecordManager.sol` (Slither 0.11.6) and `myth analyze contracts/ContactRecordManager.sol:ContactRecordManager --solv 0.8.19 -t 2` (Mythril 0.24.8).

## Running the REST service (demo)

```bash
cp .env.example .env   # fill KEK_HEX and PSEUDONYM_PEPPER_HEX with `openssl rand -hex 32`
npx ganache -p 7545 &  # or any EVM node
npm run deploy && npm run backend
```

Requests are authenticated with an EIP-191 signature over `PCTF|<action>|<target>|<timestamp>|<nonce>`; the service never accepts private keys. Transactions are signed by each stakeholder's own wallet.

## Data and scope

All data are synthetic. This is a proof-of-concept: production use needs a permissioned network, a distributed (threshold) key service, a data protection impact assessment and a legal basis for processing health data.

## Licence

MIT, see `LICENSE`.
