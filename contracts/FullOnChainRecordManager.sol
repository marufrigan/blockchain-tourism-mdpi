// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import "./RoleAccessControl.sol";

/**
 * @title FullOnChainRecordManager
 * @notice Evaluation baseline only. Same RBAC gate as PCTF, but the whole (encrypted) payload
 *         is written to contract storage instead of off-chain. Used to measure the gas and
 *         storage saved by the hybrid design. Not part of the PCTF deployment.
 */
contract FullOnChainRecordManager is RoleAccessControl {
    struct FullRecord {
        bytes32 subjectHash;
        bytes32 venueHash;
        address createdBy;
        uint64 tStart;
        uint64 tEnd;
        bytes payload;
    }

    uint256 public recordCount;
    mapping(uint256 => FullRecord) private records;
    mapping(bytes32 => uint256[]) private venueIndex;
    mapping(bytes32 => uint256[]) private subjectIndex;

    event FullRecordCreated(uint256 indexed recordId, address indexed hotel, uint256 size);

    constructor(address registryAddress) RoleAccessControl(registryAddress) {}

    function createVenueRecordFull(
        bytes32 subjectHash,
        bytes32 venueHash,
        uint64 tStart,
        uint64 tEnd,
        bytes calldata payload
    ) external enforceAccess(D_VENUE, WRITE) returns (uint256 id) {
        id = ++recordCount;
        records[id] = FullRecord(subjectHash, venueHash, msg.sender, tStart, tEnd, payload);
        venueIndex[venueHash].push(id);
        subjectIndex[subjectHash].push(id);
        emit FullRecordCreated(id, msg.sender, payload.length);
    }
}
