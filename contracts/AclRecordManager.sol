// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

/**
 * @title AclRecordManager
 * @notice Evaluation baseline only (hybrid design with simpler governance). Same on-chain anchor
 *         as PCTF (pseudonyms, content digest of the off-chain ciphertext, interval, creator),
 *         same off-chain storage and signed-challenge key release, but access is governed by
 *         per-record access lists instead of a role registry and a policy matrix:
 *         an operator allow-lists writers, and each record owner grants or revokes readers
 *         record by record. There are no roles, no data types and no on-chain consent.
 */
contract AclRecordManager {
    struct Record {
        bytes32 subjectHash;
        bytes32 venueHash;
        bytes32 contentDigest;
        address createdBy;
        uint64 tStart;
        uint64 tEnd;
    }

    address public operator;
    uint256 public recordCount;
    mapping(address => bool) public isWriter;
    mapping(uint256 => Record) private records;
    mapping(uint256 => mapping(address => bool)) private readers;
    mapping(bytes32 => uint256[]) private venueIndex;
    mapping(bytes32 => uint256[]) private subjectIndex;

    event RecordCreated(uint256 indexed recordId, bytes32 indexed venueHash, address indexed writer);
    event ReaderChanged(uint256 indexed recordId, address indexed reader, bool allowed);
    event WriterChanged(address indexed writer, bool allowed);

    constructor() {
        operator = msg.sender;
    }

    function setWriter(address w, bool allowed) external {
        require(msg.sender == operator, "ACL: operator only");
        isWriter[w] = allowed;
        emit WriterChanged(w, allowed);
    }

    function createRecord(bytes32 subjectHash, bytes32 venueHash, bytes32 contentDigest, uint64 tStart, uint64 tEnd)
        external
        returns (uint256 id)
    {
        require(isWriter[msg.sender], "ACL: not a writer");
        require(tEnd >= tStart, "ACL: bad interval");
        id = ++recordCount;
        records[id] = Record(subjectHash, venueHash, contentDigest, msg.sender, tStart, tEnd);
        readers[id][msg.sender] = true;
        venueIndex[venueHash].push(id);
        subjectIndex[subjectHash].push(id);
        emit RecordCreated(id, venueHash, msg.sender);
    }

    /// @notice Grant or revoke one reader on a batch of records owned by the caller.
    function setReader(uint256[] calldata ids, address reader, bool allowed) external {
        for (uint256 i = 0; i < ids.length; i++) {
            require(records[ids[i]].createdBy == msg.sender, "ACL: not owner");
            readers[ids[i]][reader] = allowed;
            emit ReaderChanged(ids[i], reader, allowed);
        }
    }

    function canRead(uint256 id, address who) external view returns (bool) {
        return readers[id][who];
    }

    function getRecord(uint256 id) external view returns (Record memory r) {
        require(readers[id][msg.sender], "ACL: no access");
        return records[id];
    }
}
