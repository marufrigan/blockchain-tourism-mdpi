// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "./ParticipantRegistry.sol";

/**
 * @title RoleAccessControl
 * @notice Centralised role checks against ParticipantRegistry.
 * @dev Design choice: dependency on ParticipantRegistry (not copy of roles) keeps a single source
 *      of truth. ContactRecordManager inherits this contract. Modifiers are reusable on child
 *      functions. Multi-role gates use internal _requireAnyRole to avoid duplicated require logic.
 */
abstract contract RoleAccessControl {
    ParticipantRegistry public immutable registry;

    uint8 public constant ROLE_ADMIN = 0;
    uint8 public constant ROLE_TOURIST = 1;
    uint8 public constant ROLE_HOTEL = 2;
    uint8 public constant ROLE_HEALTH_AUTHORITY = 3;
    uint8 public constant ROLE_TOURISM_AUTHORITY = 4;

    constructor(address registryAddress) {
        require(registryAddress != address(0), "RoleAccessControl: zero registry");
        registry = ParticipantRegistry(registryAddress);
    }

    modifier onlyRegistered() {
        require(registry.isRegistered(msg.sender), "RoleAccessControl: not registered");
        _;
    }

    modifier onlyAdmin() {
        _requireRole(ROLE_ADMIN);
        _;
    }

    modifier onlyTourist() {
        _requireRole(ROLE_TOURIST);
        _;
    }

    modifier onlyHotel() {
        _requireRole(ROLE_HOTEL);
        _;
    }

    modifier onlyHealthAuthority() {
        _requireRole(ROLE_HEALTH_AUTHORITY);
        _;
    }

    modifier onlyTourismAuthority() {
        _requireRole(ROLE_TOURISM_AUTHORITY);
        _;
    }

    /**
     * @notice Allows callers that hold any of the four non-tourist stakeholder roles (plus admin).
     *         Used for record creation / status updates in the prototype.
     */
    modifier onlyRecordWriter() {
        _requireAnyRole(
            ROLE_ADMIN,
            ROLE_HOTEL,
            ROLE_HEALTH_AUTHORITY,
            ROLE_TOURISM_AUTHORITY
        );
        _;
    }

    /**
     * @notice Roles allowed to read full on-chain record metadata in this prototype.
     *         Tourists are excluded on-chain; paper narrative: tourists use off-chain / backend flows.
     */
    modifier onlyRecordReader() {
        _requireAnyRole(
            ROLE_ADMIN,
            ROLE_HOTEL,
            ROLE_HEALTH_AUTHORITY,
            ROLE_TOURISM_AUTHORITY
        );
        _;
    }

    function _requireRole(uint8 expected) internal view {
        require(registry.isRegistered(msg.sender), "RoleAccessControl: not registered");
        require(registry.getRole(msg.sender) == expected, "RoleAccessControl: wrong role");
    }

    function _requireAnyRole(
        uint8 r1,
        uint8 r2,
        uint8 r3,
        uint8 r4
    ) internal view {
        require(registry.isRegistered(msg.sender), "RoleAccessControl: not registered");
        uint8 r = registry.getRole(msg.sender);
        require(
            r == r1 || r == r2 || r == r3 || r == r4,
            "RoleAccessControl: role not permitted"
        );
    }

    function _msgRole() internal view returns (uint8) {
        require(registry.isRegistered(msg.sender), "RoleAccessControl: not registered");
        return registry.getRole(msg.sender);
    }
}
