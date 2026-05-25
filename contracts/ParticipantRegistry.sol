// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title ParticipantRegistry
 * @notice Registers tourism / public-health stakeholders with RBAC roles.
 * @dev Role IDs (uint8): 0 Admin, 1 Tourist, 2 Hotel, 3 HealthAuthority, 4 TourismAuthority.
 *      Only Admin may register new participants. Deployer is bootstrap Admin.
 *      No personal identifiers are required on-chain; nameOrLabel is optional metadata (e.g. org code).
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
        uint8 role;
        string nameOrLabel;
    }

    mapping(address => Participant) private participants;

    event ParticipantRegistered(
        address indexed user,
        uint8 indexed role,
        string nameOrLabel
    );

    constructor() {
        participants[msg.sender] = Participant({
            registered: true,
            role: ROLE_ADMIN,
            nameOrLabel: "bootstrap-admin"
        });
        emit ParticipantRegistered(msg.sender, ROLE_ADMIN, "bootstrap-admin");
    }

    modifier onlyAdmin() {
        require(
            participants[msg.sender].registered &&
                participants[msg.sender].role == ROLE_ADMIN,
            "ParticipantRegistry: only admin"
        );
        _;
    }

    function _validRole(uint8 role) internal pure returns (bool) {
        return role <= ROLE_MAX;
    }

    /**
     * @notice Register a wallet with a role. Callable only by Admin.
     */
    function registerParticipant(
        address user,
        uint8 role,
        string memory nameOrLabel
    ) external onlyAdmin {
        require(user != address(0), "ParticipantRegistry: zero address");
        require(_validRole(role), "ParticipantRegistry: invalid role");
        require(!participants[user].registered, "ParticipantRegistry: already registered");

        participants[user] = Participant({
            registered: true,
            role: role,
            nameOrLabel: nameOrLabel
        });

        emit ParticipantRegistered(user, role, nameOrLabel);
    }

    function getParticipant(address user)
        external
        view
        returns (
            bool registered,
            uint8 role,
            string memory nameOrLabel
        )
    {
        Participant storage p = participants[user];
        return (p.registered, p.role, p.nameOrLabel);
    }

    function isRegistered(address user) external view returns (bool) {
        return participants[user].registered;
    }

    function getRole(address user) external view returns (uint8) {
        require(participants[user].registered, "ParticipantRegistry: not registered");
        return participants[user].role;
    }
}
