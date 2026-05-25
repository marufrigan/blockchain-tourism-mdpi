// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "./RoleAccessControl.sol";

/**
 * @title ContactRecordManager
 * @notice Privacy-preserving contact / tourism record index: hashes, off-chain references, metadata only.
 * @dev No plaintext PII on-chain. subjectHash is a pseudonymous identifier (e.g. keccak off-chain).
 */
contract ContactRecordManager is RoleAccessControl {
    struct ContactRecord {
        uint256 recordId;
        bytes32 subjectHash;
        string offChainReference;
        address createdBy;
        uint8 creatorRole;
        uint256 timestamp;
        string recordType;
        string status;
    }

    uint256 private _recordCount;
    mapping(uint256 => ContactRecord) private records;
    mapping(bytes32 => uint256[]) private subjectHashToRecordIds;

    event ContactRecordCreated(
        uint256 indexed recordId,
        bytes32 indexed subjectHash,
        string offChainReference,
        address indexed createdBy,
        uint8 creatorRole,
        string recordType,
        string status,
        uint256 timestamp
    );

    event ContactRecordStatusUpdated(
        uint256 indexed recordId,
        string newStatus,
        address indexed updatedBy
    );

    constructor(address registryAddress) RoleAccessControl(registryAddress) {}

    function createRecord(
        bytes32 subjectHash,
        string memory offChainReference,
        string memory recordType,
        string memory status
    ) external onlyRecordWriter {
        require(subjectHash != bytes32(0), "ContactRecordManager: empty subject hash");
        require(bytes(offChainReference).length > 0, "ContactRecordManager: empty reference");

        _recordCount += 1;
        uint256 id = _recordCount;
        uint8 cr = _msgRole();

        records[id] = ContactRecord({
            recordId: id,
            subjectHash: subjectHash,
            offChainReference: offChainReference,
            createdBy: msg.sender,
            creatorRole: cr,
            timestamp: block.timestamp,
            recordType: recordType,
            status: status
        });

        subjectHashToRecordIds[subjectHash].push(id);

        emit ContactRecordCreated(
            id,
            subjectHash,
            offChainReference,
            msg.sender,
            cr,
            recordType,
            status,
            block.timestamp
        );
    }

    function getRecord(uint256 recordId)
        external
        view
        onlyRecordReader
        returns (ContactRecord memory)
    {
        require(recordId > 0 && recordId <= _recordCount, "ContactRecordManager: invalid id");
        return records[recordId];
    }

    function getRecordsBySubjectHash(bytes32 subjectHash)
        external
        view
        onlyRecordReader
        returns (uint256[] memory)
    {
        return subjectHashToRecordIds[subjectHash];
    }

    function updateRecordStatus(uint256 recordId, string memory newStatus)
        external
        onlyRecordWriter
    {
        require(recordId > 0 && recordId <= _recordCount, "ContactRecordManager: invalid id");
        records[recordId].status = newStatus;
        emit ContactRecordStatusUpdated(recordId, newStatus, msg.sender);
    }

    function getRecordCount() external view returns (uint256) {
        return _recordCount;
    }
}
