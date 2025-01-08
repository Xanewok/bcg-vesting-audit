// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {console} from "forge-std/console.sol";
import {BcgVestingHandler} from "./BcgVestingHandler.sol";

contract BcgVestingInvariantTest is Test {
    BcgVestingHandler public handler;

    function setUp() public {
        // Create test accounts
        address admin = makeAddr("admin");
        address stakeController = makeAddr("stakeController");

        // Deploy handler with test accounts
        handler = new BcgVestingHandler(admin, stakeController);

        // Target the handler for invariant testing
        targetContract(address(handler));

        // Explicitly target functions that should be called during fuzzing
        bytes4[] memory selectors = new bytes4[](4);
        selectors[0] = handler.stake.selector;
        selectors[1] = handler.unstake.selector;
        selectors[2] = handler.collectRewards.selector;
        selectors[3] = handler.timeTravel.selector;

        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    function invariant_lastCollectionTimestampWeaklyIncreasing() public view {
        handler.checkLastCollectionTimestampWeaklyIncreasingInvariant();
    }

    function invariant_daysCollectedIncrement() public view {
        handler.checkDaysCollectedIncrementInvariant();
    }

    // We need deep runs to verify if the `daysCollected` correctly saturates
    // at the maximum number of days in the vesting period.
    /// forge-config: default.invariant.runs = 20
    /// forge-config: default.invariant.depth = 10000
    function invariant_daysCollected() public view {
        handler.checkDaysCollectedInvariant();
    }

    function invariant_vestingPeriodValues() public view {
        handler.checkVestingPeriodValuesInvariant();
    }

    function invariant_singleStakerOwner() public view {
        handler.checkSingleStakerOwnerInvariant();
    }

    function invariant_initialUnlockCollected() public view {
        handler.checkInitialUnlockInvariant();
    }

    function test_initialUnlockProperty(uint16 tokenId, address staker) public {
        handler.checkInitialUnlockProperty(tokenId, staker);
    }
}
