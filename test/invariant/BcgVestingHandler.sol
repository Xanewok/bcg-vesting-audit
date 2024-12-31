// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {BcgVesting} from "../../src/BcgVesting.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockERC20} from "forge-std/mocks/MockERC20.sol";
import {console} from "forge-std/console.sol";

uint256 constant BCG_TOKEN_COUNT = 6000;

contract ERC20Mint is MockERC20 {
    function mint(address to, uint256 amount) public {
        _mint(to, amount);
    }
}

contract BcgVestingHandler is Test {
    BcgVesting public bcgVesting;
    ERC20Mint public beramoToken;
    address public admin;
    address public stakeController;

    // We track which address staked each token, so we can verify the VestingPeriod.owner
    // does not change mid-staking.
    mapping(uint16 => address) internal stakerRegistry;

    // Sample data for testing
    // Since the contract has uniform behavior for all tokens, we can use a subset of token IDs
    uint16 public startingTokenId;
    uint16 public subsetSize = 5;

    constructor(address _admin, address _stakeController) {
        admin = _admin;
        stakeController = _stakeController;

        // Deploy test tokens
        beramoToken = new ERC20Mint();

        // Deploy BcgVesting
        bcgVesting = new BcgVesting(IERC20(address(beramoToken)), stakeController);
        // Make sure the caller by default has the admin role
        bcgVesting.grantRole(bcgVesting.DEFAULT_ADMIN_ROLE(), admin);

        // Initialize vesting pool
        uint256 vestingPoolTotal = bcgVesting.VESTING_POOL_TOTAL();
        beramoToken.mint(admin, vestingPoolTotal);
        vm.startPrank(admin);
        beramoToken.approve(address(bcgVesting), vestingPoolTotal);
        bcgVesting.initializeVestingPool();
        vm.stopPrank();

        // Setup the token ID sample data
        uint256 seed = uint256(keccak256(abi.encode(block.timestamp)));
        startingTokenId = uint16(seed % BCG_TOKEN_COUNT);

        while (startingTokenId + subsetSize > BCG_TOKEN_COUNT) {
            seed = uint256(keccak256(abi.encode(seed)));
            startingTokenId = uint16(seed % BCG_TOKEN_COUNT);
        }
        console.log("Starting token ID: %d", startingTokenId);
    }

    function _isStaked(uint16 tokenId) internal view returns (bool) {
        (, , BcgVesting.VestingPeriod memory v) = bcgVesting.vestingState(tokenId);
        // If owner is non-zero, it's staked
        return v.owner != address(0);
    }

    function stake(uint16 tokenId) public {
        tokenId = uint16(
            bound(tokenId, startingTokenId, startingTokenId + subsetSize - 1)
        );

        if (!_isStaked(tokenId)) {
            vm.startPrank(stakeController);
            bcgVesting.onTokenStaked(address(this), tokenId);
            vm.stopPrank();

            // Record the staker address once for this staking period
            stakerRegistry[tokenId] = address(this);
        }
    }

    function unstake(uint16 tokenId) public {
        tokenId = uint16(
            bound(tokenId, startingTokenId, startingTokenId + subsetSize - 1)
        );

        // Try to increase coverage by increasing probability to unstake only
        // when the pending rewards are accrued
        uint256 seed = uint256(keccak256(abi.encode(blockhash(block.number - 1))));
        if (seed % 5 <= 3 && bcgVesting.pendingRewards(tokenId) <= 0) {
            return;
        }

        if (_isStaked(tokenId)) {
            vm.startPrank(stakeController);
            bcgVesting.onTokenUnstaked(address(this), tokenId);
            vm.stopPrank();

            // Reset the staker record once it's unstaked
            stakerRegistry[tokenId] = address(0);
        }
    }

    function collectRewards(uint16 tokenId) public {
        tokenId = uint16(
            bound(tokenId, startingTokenId, startingTokenId + subsetSize - 1)
        );

        (, , BcgVesting.VestingPeriod memory state) = bcgVesting.vestingState(tokenId);

        // To increase the coverage, randomly try to collect either as the
        // owner or the stake controller (only they can collect rewards)
        address caller = tokenId % 2 == 0 ? state.owner : stakeController;
        vm.startPrank(caller);
        bcgVesting.collectPendingRewards(tokenId);
        vm.stopPrank();
    }

    function timeTravel(uint16 seconds_) public {
        seconds_ = uint16(bound(seconds_, 0, 5 days));

        // We do not want to warp past the max timestamp; the 48-bits used internally
        // enable us to go up to millions of years, so let's ensure we don't
        uint48 maxTimestamp = 1_000_000 * 365 days;

        uint256 newTimestamp = block.timestamp + seconds_;
        vm.assume(newTimestamp < maxTimestamp);
        vm.warp(newTimestamp);
    }

    // Invariant helpers
    function checkLastCollectionTimestampInvariant() public view {
        for (uint16 id = startingTokenId; id < startingTokenId + subsetSize; id++) {
            (, , BcgVesting.VestingPeriod memory vesting) = bcgVesting.vestingState(id);

            require(
                vesting.lastCollectionTimestamp >= vesting.startTimestamp,
                "Invariant violation: lastCollectionTimestamp < startTimestamp"
            );
        }
    }

    function checkDaysCollectedInvariant() public view {
        for (uint16 id = startingTokenId; id < startingTokenId + subsetSize; id++) {
            (uint256 daysCollected, , ) = bcgVesting.vestingState(id);

            require(
                daysCollected <= bcgVesting.VESTING_PERIOD_IN_DAYS(),
                "Invariant violation: daysCollected > VESTING_PERIOD_IN_DAYS"
            );
        }
    }

    function checkVestingPeriodValuesInvariant() public view {
        for (uint16 id = startingTokenId; id < startingTokenId + subsetSize; id++) {
            (, , BcgVesting.VestingPeriod memory vesting) = bcgVesting.vestingState(id);

            bool allZero = vesting.owner == address(0) &&
                vesting.startTimestamp == 0 &&
                vesting.lastCollectionTimestamp == 0;
            bool allNonZero = vesting.owner != address(0) &&
                vesting.startTimestamp != 0 &&
                vesting.lastCollectionTimestamp != 0;
            require(
                allZero != allNonZero,
                "Invariant violation: VestingPeriod values must be all zero or all non-zero"
            );
        }
    }

    function checkSingleStakerOwnerInvariant() public view {
        for (uint16 id = startingTokenId; id < startingTokenId + subsetSize; id++) {
            // Read the vesting data for this token
            (, , BcgVesting.VestingPeriod memory vesting) = bcgVesting.vestingState(id);

            // If the token is staked (owner != address(0)), then check the recorded staker
            if (vesting.owner != address(0)) {
                require(
                    vesting.owner == stakerRegistry[id],
                    "Invariant violation: staker changed mid-staking!"
                );
            }
        }
    }

    function checkInitialUnlockInvariant() public view {
        for (uint16 id = startingTokenId; id < startingTokenId + subsetSize; id++) {
            (
                uint256 daysCollected,
                bool initialUnlockCollected,
                BcgVesting.VestingPeriod memory vesting
            ) = bcgVesting.vestingState(id);

            if (!initialUnlockCollected) {
                // If no initial unlock has been collected, token must never have been staked
                require(
                    vesting.owner == address(0) &&
                        vesting.startTimestamp == 0 &&
                        vesting.lastCollectionTimestamp == 0 &&
                        daysCollected == 0,
                    "Invariant violation: No initial unlock collected, but token shows vesting activity"
                );
            }
        }
    }

    function checkInitialUnlockProperty(uint16 tokenId, address staker) public {
        vm.assume(staker != address(0));
        vm.assume(tokenId < BCG_TOKEN_COUNT);

        // Check the current state of the token
        (
            uint256 daysCollected,
            bool initialUnlockCollected,
            BcgVesting.VestingPeriod memory vesting
        ) = bcgVesting.vestingState(tokenId);

        // If the token has never been staked, these conditions should hold true
        vm.assume(!initialUnlockCollected);
        vm.assume(
            vesting.owner == address(0) &&
                vesting.startTimestamp == 0 &&
                vesting.lastCollectionTimestamp == 0
        );
        vm.assume(daysCollected == 0);

        uint256 stakerBalanceBefore = beramoToken.balanceOf(staker);

        // Stake the token for the first time using the stakeController role
        vm.startPrank(stakeController);
        bcgVesting.onTokenStaked(staker, tokenId);
        vm.stopPrank();

        uint256 stakerBalanceAfter = beramoToken.balanceOf(staker);

        // After the first stake, the staker should receive the initial unlock amount
        require(
            stakerBalanceAfter > stakerBalanceBefore,
            "Initial unlock was not granted to the first staker"
        );
    }
}
