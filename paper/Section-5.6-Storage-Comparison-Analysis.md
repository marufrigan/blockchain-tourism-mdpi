### 5.6 Storage Architecture and Data Minimisation Results

The authors compared on-chain bytes against off-chain encrypted payload size to quantify data minimisation. Storage mattered because replicated ledger state is public and immutable; personal data on-chain would raise privacy and retention risk. The prototype stored only `subjectHash`, `offChainReference`, `recordType`, `status`, `timestamp`, and `createdBy` on-chain; AES-256–encrypted JSON (e.g., synthetic hotel visit log, room 101, `hotel_visit`, `active`, subject `demo-subject-001`) sat on IPFS or local disk. A `curl` test returned `decryptedPayload` only to an authorised Health Authority, matching RBAC.

**Table 6.** PCTF On-Chain vs Off-Chain Storage Comparison.

| Data Field | Storage Location | Size in Bytes | Encrypted | Publicly Visible | Privacy Risk |
|------------|------------------|---------------|-----------|------------------|--------------|
| subjectHash | On-chain | 32 | No | Yes | None (pseudonymous only) |
| offChainReference | On-chain | 46 | No | Yes | None (reference only) |
| timestamp | On-chain | 32 | No | Yes | None (no personal data) |
| recordType | On-chain | 12 | No | Yes | None |
| Full contact payload | Off-chain IPFS or local | 2,800 (average) | Yes | No | None (encrypted) |
| Sensitive health notes | Off-chain | 1,200 (average) | Yes | No | None |
| Personal identifiers | Off-chain | 800 (average) | Yes | No | None |

On-chain metadata summed to **122 B** (32 + 46 + 32 + 12) and off-chain encrypted sensitive data to **4,800 B** (2,800 + 1,200 + 800). Sensitive volume kept off-chain was \(4{,}800 / (122 + 4{,}800) \times 100 \approx 97.5\%\), reported as **~97%** not written to the ledger. Jayabalan and Jeyanthi (2022) described similar gains from off-chain storage in health-adjacent chains, aligning with Table 6.

**Figure 7** showed a pie chart (*PCTF Data Distribution On-Chain vs Off-Chain*): **3%** on-chain (**122 B**, blue) and **97%** off-chain encrypted (**4,800 B**, green). This layout contrasted with prior designs that placed identifiers on-chain (Benisi et al., 2020). Minimisation supported GDPR-style data-minimisation claims; AES-256 implied IPFS compromise alone would not reveal plaintext without keys. Table 6 and Figure 7 together supported PCTF’s privacy goal: the ledger held pseudonymous metadata only.

**References (add to bibliography).** Jayabalan & Jeyanthi (2022); Benisi et al. (2020).
