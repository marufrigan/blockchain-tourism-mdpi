**Table 5.** Gas consumption and implied ether cost (20 Gwei) for representative PCTF smart-contract operations.

| Operation | Role | Gas Used | ETH Cost at 20 Gwei | Status |
|-----------|------|----------|----------------------|--------|
| registerParticipant | Admin | 73,201 | 0.00146402 | success |
| createRecord | Hotel | 228,130 | 0.00456260 | success |
| updateRecordStatus | HealthAuthority | 39,388 | 0.00078776 | success |
| getRecord (static call) | HealthAuthority | 0 | 0.00000000 | read (no user gas) |
| createRecord (unauthorised) | Tourist | 31,560 | 0.00063120 | revert |
| Batch 5× registerParticipant (sum) | Admin | 365,141 | 0.00730282 | success (aggregate) |
