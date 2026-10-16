// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

/**
 * @title ParticipantRegistry
 * @notice Registers PCTF stakeholders and binds each wallet to exactly one role.
 * @dev Role IDs: 0 Admin, 1 Tourist, 2 Hotel, 3 HealthAuthority, 4 TourismAuthority.
 *      Only an active Admin can register, re-assign or revoke participants.
 *      No personal identifiers are stored; `label` is an optional organisation code.
 */
contract ParticipantRegistry {
    uint8 public constant ROLE_ADMIN = 0;
    uint8 public constant ROLE_TOURIST = 1;
    uint8 public constant ROLE_HOTEL = 2;
    uint8 public constant ROLE_HEALTH_AUTHORITY = 3;
    uint8 public constant ROLE_TOURISM_AUTHORITY = 4;
    uint8 public constant ROLE_MAX = 4;

    struct Participant {
        bool registered;
        bool active;
        uint8 role;
        string label;
    }

    mapping(address => Participant) private participants;
    uint256 public activeAdmins;

    event ParticipantRegistered(address indexed user, uint8 indexed role, string label);
    event RoleUpdated(address indexed user, uint8 oldRole, uint8 newRole);
    event ParticipantRevoked(address indexed user, uint8 role);

    constructor() {
        participants[msg.sender] = Participant(true, true, ROLE_ADMIN, "bootstrap-admin");
        activeAdmins = 1;
        emit ParticipantRegistered(msg.sender, ROLE_ADMIN, "bootstrap-admin");
    }

    modifier onlyAdmin() {
        Participant storage p = participants[msg.sender];
        require(p.active && p.role == ROLE_ADMIN, "Registry: only admin");
        _;
    }

    function registerParticipant(address user, uint8 role, string calldata label) external onlyAdmin {
        require(user != address(0), "Registry: zero address");
        require(role <= ROLE_MAX, "Registry: invalid role");
        require(!participants[user].registered, "Registry: already registered");
        participants[user] = Participant(true, true, role, label);
        if (role == ROLE_ADMIN) activeAdmins += 1;
        emit ParticipantRegistered(user, role, label);
    }

    /// @notice Re-assign the role of an active participant (e.g. change of affiliation).
    function updateRole(address user, uint8 newRole) external onlyAdmin {
        require(newRole <= ROLE_MAX, "Registry: invalid role");
        Participant storage p = participants[user];
        require(p.active, "Registry: not active");
        uint8 oldRole = p.role;
        require(oldRole != newRole, "Registry: same role");
        if (oldRole == ROLE_ADMIN) {
            require(activeAdmins > 1, "Registry: last admin");
            activeAdmins -= 1;
        }
        if (newRole == ROLE_ADMIN) activeAdmins += 1;
        p.role = newRole;
        emit RoleUpdated(user, oldRole, newRole);
    }

    /// @notice Revoke a participant. A revoked wallet fails every role check.
    function revokeParticipant(address user) external onlyAdmin {
        Participant storage p = participants[user];
        require(p.active, "Registry: not active");
        if (p.role == ROLE_ADMIN) {
            require(activeAdmins > 1, "Registry: last admin");
            activeAdmins -= 1;
        }
        p.active = false;
        emit ParticipantRevoked(user, p.role);
    }

    function getParticipant(address user)
        external
        view
        returns (bool registered, bool active, uint8 role, string memory label)
    {
        Participant storage p = participants[user];
        return (p.registered, p.active, p.role, p.label);
    }

    function isActive(address user) external view returns (bool) {
        return participants[user].active;
    }

    /// @notice Returns (active, role) in a single call for access checks.
    function roleOf(address user) external view returns (bool active, uint8 role) {
        Participant storage p = participants[user];
        return (p.active, p.role);
    }
}
