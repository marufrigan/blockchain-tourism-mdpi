### 5.5 Gas Consumption Analysis

Gas metering limited how many state-changing interactions the prototype could sustain on an Ethereum-compatible ledger: each successful write updated contract storage and paid for opcode execution, whereas the off-chain layer held ciphertext and large payloads and reduced on-chain storage pressure by approximately 97% relative to placing raw contact records entirely on-chain. The authors still reported EVM gas because registration and the on-chain record index remained on the critical path for accountability and RBAC. Measurements used transaction receipts from `ParticipantRegistry` and `ContactRecordManager` deployed via Truffle on a local Ganache node (`http://127.0.0.1:8545`); ether equivalents assumed a nominal **20 Gwei** gas price for comparability across experiments.

**Table 5** summarised the measured operations, roles, gas used, implied ether cost at 20 Gwei, and transaction outcome. Registration by an administrator (`registerParticipant`) consumed **73,201** gas, while the heaviest successful write in the sample was `createRecord` issued by a hotel (**228,130** gas), reflecting the cost of appending a new indexed record and emitting events. A health-authority status update (`updateRecordStatus`) required **39,388** gas—lower than creation because it modified an existing slot rather than allocating a new record. The static `getRecord` call executed as an off-chain read against the contract ABI and therefore appeared with **zero** end-user gas in the table, which matched the design choice to avoid charging tourists for read paths that were not executed as on-chain transactions in this setup. An unauthorised `createRecord` sent by a tourist **reverted** after role checks; it consumed **31,560** gas, substantially less than successful hotel writes, which indicated that access control failed early and avoided full record-commit costs. Finally, the sum of gas for **five** successive `registerParticipant` calls by the administrator (**365,141** gas aggregate) illustrated the cumulative cost of onboarding multiple stakeholders in a short window; individual registrations were not itemised in the last row, but the aggregate supported batching and capacity planning discussions.

**Table 5.** Gas consumption and implied ether cost (20 Gwei) for representative PCTF smart-contract operations.

| Operation | Role | Gas Used | ETH Cost at 20 Gwei | Status |
|-----------|------|----------|----------------------|--------|
| registerParticipant | Admin | 73,201 | 0.00146402 | success |
| createRecord | Hotel | 228,130 | 0.00456260 | success |
| updateRecordStatus | HealthAuthority | 39,388 | 0.00078776 | success |
| getRecord (static call) | HealthAuthority | 0 | 0.00000000 | read (no user gas) |
| createRecord (unauthorised) | Tourist | 31,560 | 0.00063120 | revert |
| Batch 5× registerParticipant (sum) | Admin | 365,141 | 0.00730282 | success (aggregate) |

**Figure 6** visualised the same gas figures in grouped-bar form so that successful writes, reverted paths, and read-only operations could be compared at a glance. The chart was generated as a standalone HTML page (`gas-chart.html`) using Chart.js; the vertical axis listed **gas units**, and each operation appeared on the horizontal axis with up to three series—**blue** for successful writes, **red** for reverted transactions, and **green** for read operations (including the zero-height bar for static `getRecord`). The figure highlighted two patterns also visible in Table 5: successful writes dominated the scale (with `createRecord` and the five-registration aggregate forming the tallest bars), while the unauthorised tourist write appeared only in the red series at moderate height, reinforcing that enforcement was gas-efficient relative to committed state changes. The read operation remained visually near the baseline, consistent with the table’s zero gas entry for end users.

**Figure 6.** *PCTF Smart Contract Gas Consumption Analysis* — grouped bar chart of gas units per operation; blue = successful writes, red = revert (access denied), green = read / no user gas (static call).

Taken together, Table 5 and Figure 6 provided an Ethereum-layer cost snapshot for the prototype. Hyperledger Fabric evaluations typically emphasised throughput and endorsement latency rather than EVM gas [1], [2], so these results were not directly comparable to permissioned-chain benchmarks but still motivated a production strategy: deploy the same contract interfaces on a **Layer-2** rollup or enterprise sidechain to amortise registration and indexing gas, while retaining the off-chain ciphertext architecture.

**References.** [1] G. Wood, *Ethereum Yellow Paper*. [2] E. Androulaki et al., Hyperledger Fabric, *EuroSys*, 2018.

*Regenerate Table 5 and Figure 6 data with `npm run gas-analysis` (outputs: `gas-report.csv`, `gas-chart.html`).*
