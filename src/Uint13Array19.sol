// SPDX-License-Identifier: WTFPL
pragma solidity ^0.8.13;

library Uint13Array19 {
    type u13a19 is uint256;

    uint8 constant bits = 13;
    uint8 constant elements = 19;

    uint256 constant range = 1 << bits;
    uint256 constant max = range - 1;

    function get(u13a19 va, uint256 index) internal pure returns (uint256) {
        require(index < elements);
        return (u13a19.unwrap(va) >> (bits * index)) & max;
    }

    function set(u13a19 va, uint256 index, uint256 value) internal pure returns (u13a19) {
        require(value < range && index < elements);
        index *= bits;
        return u13a19.wrap((u13a19.unwrap(va) & ~(max << index)) | (value << index));
    }
}
