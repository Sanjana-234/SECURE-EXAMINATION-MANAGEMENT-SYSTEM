// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// Append-only registry of SHA-256 integrity hashes. No personal data is ever stored on-chain.
contract ExamIntegrity {
    struct Record { bytes32 hash; uint64 timestamp; }
    address public immutable owner;
    Record[] private records;
    event HashAnchored(uint256 indexed index, bytes32 hash, uint64 timestamp);

    constructor() { owner = msg.sender; }

    function anchor(bytes32 hash) external returns (uint256 index) {
        require(msg.sender == owner, "not owner");
        records.push(Record(hash, uint64(block.timestamp)));
        index = records.length - 1;
        emit HashAnchored(index, hash, uint64(block.timestamp));
    }
    function get(uint256 index) external view returns (bytes32, uint64) {
        require(index < records.length, "out of range");
        Record storage r = records[index];
        return (r.hash, r.timestamp);
    }
    function count() external view returns (uint256) { return records.length; }
}
