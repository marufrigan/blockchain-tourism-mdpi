// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import "./ParticipantRegistry.sol";

/**
 * @title RoleAccessControl
 * @notice Implements the PCTF policy P ⊆ R × D × A as a 64-bit matrix and the decision
 *         function δ(pk, d, a) = ρ(φ(pk), d, a). φ is read from ParticipantRegistry.
 * @dev Bit index for (role r, data type d, action a) = r*10 + d*2 + a.
 *      Data types: 0 d_o individual/exposure, 1 d_v venue check-in, 2 d_x diagnostic,
 *                  3 d_g aggregate statistics, 4 d_c configuration.
 *      Actions: 0 READ, 1 WRITE.
 *      Write checks are binding (enforced in transactions). Read checks on view functions
 *      only shape the API: blockchain state is public, so confidentiality of payloads relies
 *      on encryption and the off-chain key-release service, which re-checks this same policy.
 */
abstract contract RoleAccessControl {
    ParticipantRegistry public immutable registry;

    uint8 internal constant ROLE_ADMIN = 0;
    uint8 internal constant ROLE_TOURIST = 1;
    uint8 internal constant ROLE_HOTEL = 2;
    uint8 internal constant ROLE_HEALTH = 3;
    uint8 internal constant ROLE_TOURISM = 4;

    uint8 public constant D_INDIVIDUAL = 0;
    uint8 public constant D_VENUE = 1;
    uint8 public constant D_DIAGNOSTIC = 2;
    uint8 public constant D_AGGREGATE = 3;
    uint8 public constant D_CONFIG = 4;

    uint8 public constant READ = 0;
    uint8 public constant WRITE = 1;

    uint64 public policyBits;

    event PolicyUpdated(uint8 indexed role, uint8 indexed dataType, uint8 action, bool allowed, address by);

    constructor(address registryAddress) {
        require(registryAddress != address(0), "RBAC: zero registry");
        registry = ParticipantRegistry(registryAddress);
        uint64 b = 0;
        // Tourist: own individual records (exposure status) and own diagnostic status
        b |= _bit(ROLE_TOURIST, D_INDIVIDUAL, READ);
        b |= _bit(ROLE_TOURIST, D_DIAGNOSTIC, READ);
        // Hotel: write and read its own venue check-ins; read aggregates
        b |= _bit(ROLE_HOTEL, D_VENUE, READ);
        b |= _bit(ROLE_HOTEL, D_VENUE, WRITE);
        b |= _bit(ROLE_HOTEL, D_AGGREGATE, READ);
        // Health authority: read venue and individual data, read/write diagnostics,
        // write exposure notices (individual) and aggregates
        b |= _bit(ROLE_HEALTH, D_INDIVIDUAL, READ);
        b |= _bit(ROLE_HEALTH, D_INDIVIDUAL, WRITE);
        b |= _bit(ROLE_HEALTH, D_VENUE, READ);
        b |= _bit(ROLE_HEALTH, D_DIAGNOSTIC, READ);
        b |= _bit(ROLE_HEALTH, D_DIAGNOSTIC, WRITE);
        b |= _bit(ROLE_HEALTH, D_AGGREGATE, READ);
        b |= _bit(ROLE_HEALTH, D_AGGREGATE, WRITE);
        // Tourism authority: aggregate statistics only
        b |= _bit(ROLE_TOURISM, D_AGGREGATE, READ);
        // Admin: configuration only (no access to personal or health data)
        b |= _bit(ROLE_ADMIN, D_CONFIG, READ);
        b |= _bit(ROLE_ADMIN, D_CONFIG, WRITE);
        policyBits = b;
    }

    function _bit(uint8 role, uint8 dataType, uint8 action) internal pure returns (uint64) {
        return uint64(1) << (uint64(role) * 10 + uint64(dataType) * 2 + uint64(action));
    }

    /// @notice ρ(r, d, a)
    function isAllowed(uint8 role, uint8 dataType, uint8 action) public view returns (bool) {
        if (role > 4 || dataType > 4 || action > 1) return false;
        return policyBits & _bit(role, dataType, action) != 0;
    }

    /// @notice δ(pk, d, a): returns the caller role when access is granted, reverts otherwise.
    function _authorize(address who, uint8 dataType, uint8 action) internal view returns (uint8) {
        (bool active, uint8 role) = registry.roleOf(who);
        require(active, "RBAC: not registered");
        require(isAllowed(role, dataType, action), "RBAC: unauthorized");
        return role;
    }

    modifier enforceAccess(uint8 dataType, uint8 action) {
        _authorize(msg.sender, dataType, action);
        _;
    }

    /// @notice Policy changes are configuration writes and are logged on-chain.
    function setPolicy(uint8 role, uint8 dataType, uint8 action, bool allowed)
        external
        enforceAccess(D_CONFIG, WRITE)
    {
        require(role <= 4 && dataType <= 4 && action <= 1, "RBAC: bad index");
        uint64 m = _bit(role, dataType, action);
        policyBits = allowed ? (policyBits | m) : (policyBits & ~m);
        emit PolicyUpdated(role, dataType, action, allowed, msg.sender);
    }
}
