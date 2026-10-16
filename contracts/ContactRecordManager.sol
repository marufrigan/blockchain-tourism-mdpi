// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import "./RoleAccessControl.sol";

/**
 * @title ContactRecordManager
 * @notice PCTF on-chain index. Stores only pseudonyms, a content digest of the encrypted
 *         off-chain payload, coarse metadata and the creator. No plaintext payload is stored.
 * @dev contentDigest = SHA-256(ciphertext). The off-chain object is content-addressed by this
 *      digest (local store file name or IPFS CIDv1 raw/sha2-256), so the reference is derivable
 *      and any tampering is detected by recomputing the digest.
 */
contract ContactRecordManager is RoleAccessControl {
    uint8 public constant STATUS_ACTIVE = 0;
    uint8 public constant STATUS_EXPIRED = 1;
    uint8 public constant STATUS_REVOKED = 2;

    uint256 public constant MAX_NOTIFY_BATCH = 100;
    uint256 public constant MAX_WINDOW = 21 days;

    struct Record {
        bytes32 subjectHash;   // HMAC pseudonym of the subject for the record's epoch
        bytes32 venueHash;     // HMAC pseudonym of the venue (zero for diagnostics)
        bytes32 contentDigest; // SHA-256 of the off-chain ciphertext
        address createdBy;
        uint8 dataType;        // D_VENUE or D_DIAGNOSTIC
        uint8 status;
        uint8 storageScheme;   // 0 local content-addressed store, 1 IPFS
        uint64 tStart;
        uint64 tEnd;
        uint64 createdAt;
        uint64 expiresAt;
    }

    struct Aggregate {
        uint32 cases;
        uint32 exposures;
        uint64 publishedAt;
    }

    uint256 public recordCount;
    mapping(uint256 => Record) private records;
    mapping(bytes32 => uint256[]) private venueIndex;
    mapping(bytes32 => uint256[]) private subjectIndex;
    mapping(bytes32 => uint256) private exposureOf; // subject pseudonym -> diagnosis record id
    mapping(bytes32 => Aggregate) private aggregates;
    mapping(address => bool) public consentGiven;

    event VenueRecordCreated(uint256 indexed recordId, bytes32 indexed venueHash, address indexed hotel);
    event DiagnosisRecorded(uint256 indexed recordId, address indexed authority);
    event ExposureNotified(uint256 indexed diagnosisId, bytes32 indexed subjectHash);
    event RecordStatusUpdated(uint256 indexed recordId, uint8 status, address indexed by);
    event AggregatePublished(bytes32 indexed regionDay, uint32 cases, uint32 exposures);
    event ConsentChanged(address indexed tourist, bool given);

    constructor(address registryAddress) RoleAccessControl(registryAddress) {}

    // ------------------------------------------------------------------ writes

    /// @notice Algorithm 2: a Hotel anchors an encrypted venue check-in.
    function createVenueRecord(
        bytes32 subjectHash,
        bytes32 venueHash,
        bytes32 contentDigest,
        uint64 tStart,
        uint64 tEnd,
        uint64 ttl,
        uint8 storageScheme
    ) external enforceAccess(D_VENUE, WRITE) returns (uint256 id) {
        require(subjectHash != bytes32(0) && venueHash != bytes32(0), "CRM: empty pseudonym");
        require(contentDigest != bytes32(0), "CRM: empty digest");
        require(tEnd >= tStart, "CRM: bad interval");
        id = _store(subjectHash, venueHash, contentDigest, D_VENUE, tStart, tEnd, ttl, storageScheme);
        venueIndex[venueHash].push(id);
        emit VenueRecordCreated(id, venueHash, msg.sender);
    }

    /// @notice Algorithm 3 (step 1): a Health Authority records a confirmed diagnosis.
    function recordDiagnosis(
        bytes32 subjectHash,
        bytes32 contentDigest,
        uint64 tDiagnosis,
        uint64 window,
        uint64 ttl,
        uint8 storageScheme
    ) external enforceAccess(D_DIAGNOSTIC, WRITE) returns (uint256 id) {
        require(subjectHash != bytes32(0) && contentDigest != bytes32(0), "CRM: empty field");
        require(window > 0 && window <= MAX_WINDOW && tDiagnosis >= window, "CRM: bad window");
        id = _store(subjectHash, bytes32(0), contentDigest, D_DIAGNOSTIC, tDiagnosis - window, tDiagnosis, ttl, storageScheme);
        emit DiagnosisRecorded(id, msg.sender);
    }

    /// @notice Algorithm 3 (step 3): publish exposure notices for matched pseudonyms.
    function notifyExposures(uint256 diagnosisId, bytes32[] calldata exposedSubjects)
        external
        enforceAccess(D_INDIVIDUAL, WRITE)
    {
        require(exposedSubjects.length <= MAX_NOTIFY_BATCH, "CRM: batch too large");
        Record storage d = records[diagnosisId];
        require(d.dataType == D_DIAGNOSTIC && d.status == STATUS_ACTIVE, "CRM: not a diagnosis");
        for (uint256 i = 0; i < exposedSubjects.length; i++) {
            exposureOf[exposedSubjects[i]] = diagnosisId;
            emit ExposureNotified(diagnosisId, exposedSubjects[i]);
        }
    }

    function publishAggregate(bytes32 regionDay, uint32 cases, uint32 exposures)
        external
        enforceAccess(D_AGGREGATE, WRITE)
    {
        aggregates[regionDay] = Aggregate(cases, exposures, uint64(block.timestamp));
        emit AggregatePublished(regionDay, cases, exposures);
    }

    /// @notice Status changes need WRITE on the record's data type; hotels only on their own records.
    function updateRecordStatus(uint256 recordId, uint8 newStatus) external {
        require(recordId > 0 && recordId <= recordCount, "CRM: invalid id");
        require(newStatus <= STATUS_REVOKED, "CRM: bad status");
        Record storage r = records[recordId];
        uint8 role = _authorize(msg.sender, r.dataType, WRITE);
        if (role == ROLE_HOTEL) require(r.createdBy == msg.sender, "CRM: not record owner");
        r.status = newStatus;
        emit RecordStatusUpdated(recordId, newStatus, msg.sender);
    }

    /// @notice Tourists record or withdraw consent; the key service destroys keys on withdrawal.
    function setConsent(bool given) external {
        (bool active, uint8 role) = registry.roleOf(msg.sender);
        require(active && role == ROLE_TOURIST, "CRM: tourists only");
        consentGiven[msg.sender] = given;
        emit ConsentChanged(msg.sender, given);
    }

    function _store(
        bytes32 subjectHash,
        bytes32 venueHash,
        bytes32 contentDigest,
        uint8 dataType,
        uint64 tStart,
        uint64 tEnd,
        uint64 ttl,
        uint8 storageScheme
    ) private returns (uint256 id) {
        require(storageScheme <= 1, "CRM: bad scheme");
        id = ++recordCount;
        uint64 nowTs = uint64(block.timestamp);
        records[id] = Record({
            subjectHash: subjectHash,
            venueHash: venueHash,
            contentDigest: contentDigest,
            createdBy: msg.sender,
            dataType: dataType,
            status: STATUS_ACTIVE,
            storageScheme: storageScheme,
            tStart: tStart,
            tEnd: tEnd,
            createdAt: nowTs,
            expiresAt: ttl == 0 ? 0 : nowTs + ttl
        });
        subjectIndex[subjectHash].push(id);
    }

    // ------------------------------------------------------------------ reads (API shaping only)

    function getRecord(uint256 recordId) external view returns (Record memory r) {
        require(recordId > 0 && recordId <= recordCount, "CRM: invalid id");
        r = records[recordId];
        uint8 role = _authorize(msg.sender, r.dataType, READ);
        if (role == ROLE_HOTEL) require(r.createdBy == msg.sender, "CRM: not record owner");
        require(role != ROLE_TOURIST, "CRM: use key service for own records");
    }

    /// @notice Minimal public metadata used by the key-release service. Contract storage is
    ///         publicly readable anyway, so this exposes nothing new; it contains no pseudonyms.
    function recordMeta(uint256 recordId)
        external
        view
        returns (bytes32 contentDigest, uint8 dataType, uint8 status, uint8 storageScheme, uint64 expiresAt)
    {
        require(recordId > 0 && recordId <= recordCount, "CRM: invalid id");
        Record storage r = records[recordId];
        return (r.contentDigest, r.dataType, r.status, r.storageScheme, r.expiresAt);
    }

    function getVenueRecordIds(bytes32 venueHash, uint256 start, uint256 max)
        external
        view
        enforceAccess(D_VENUE, READ)
        returns (uint256[] memory ids)
    {
        return _slice(venueIndex[venueHash], start, max);
    }

    function getSubjectRecordIds(bytes32 subjectHash, uint256 start, uint256 max)
        external
        view
        enforceAccess(D_INDIVIDUAL, READ)
        returns (uint256[] memory ids)
    {
        (bool active, uint8 role) = registry.roleOf(msg.sender);
        require(active && role != ROLE_TOURIST, "CRM: use key service for own records");
        return _slice(subjectIndex[subjectHash], start, max);
    }

    /// @notice Exposure status for a pseudonym (0 = not exposed). Tourists query their own pseudonyms.
    function getExposure(bytes32 subjectHash) external view enforceAccess(D_INDIVIDUAL, READ) returns (uint256) {
        return exposureOf[subjectHash];
    }

    function getAggregate(bytes32 regionDay)
        external
        view
        enforceAccess(D_AGGREGATE, READ)
        returns (Aggregate memory)
    {
        return aggregates[regionDay];
    }

    function _slice(uint256[] storage a, uint256 start, uint256 max) private view returns (uint256[] memory out) {
        if (start >= a.length) return new uint256[](0);
        uint256 end = start + max;
        if (end > a.length) end = a.length;
        out = new uint256[](end - start);
        for (uint256 i = start; i < end; i++) out[i - start] = a[i];
    }
}
