// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

/**
 * @title AuditAnchor
 * @notice Periodically anchors the head hash of the key-release service's hash-chained audit log.
 *         After an anchor, rewriting any earlier log entry changes the recomputed head and no longer
 *         matches the on-chain value. Deployed separately from the record manager.
 */
contract AuditAnchor {
    address public immutable service;
    bytes32 public head;
    uint64 public entries;

    event Anchored(bytes32 indexed head, uint64 entries, uint64 at);

    constructor(address keyService) {
        service = keyService;
    }

    function anchor(bytes32 newHead, uint64 count) external {
        require(msg.sender == service, "Anchor: service only");
        require(count >= entries, "Anchor: log cannot shrink");
        head = newHead;
        entries = count;
        emit Anchored(newHead, count, uint64(block.timestamp));
    }
}
