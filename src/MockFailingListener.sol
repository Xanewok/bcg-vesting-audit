// contracts/test/MockFailingListener.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract MockFailingListener {
    function onTokenStaked(address, uint256) external pure {
        revert("Listener failed");
    }

    function onTokenUnstaked(address, uint256) external pure {
        revert("Listener failed");
    }
}
