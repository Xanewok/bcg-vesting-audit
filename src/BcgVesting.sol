// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

using SafeERC20 for IERC20;

uint256 constant BCG_TOKEN_COUNT = 6000;
uint256 constant UNIQUE_BERA_COUNT = 13;

/** Returns whether a BCG token ID represents a unique (1/1) Bera. */
function isUnique(uint256 tokenId) pure returns (bool) {
    // For just 13 items that will not dominate the gas cost,
    // we stick with a simple linear scan
    return (tokenId == 931 || // The Dark Knight
        tokenId == 1198 || // Hologram
        tokenId == 2513 || // Kishant
        tokenId == 2627 || // Killi
        tokenId == 3152 || // The Holy Dark Spirit
        tokenId == 3417 || // Ulhal
        tokenId == 3755 || // The Void Mage
        tokenId == 4191 || // Waiku
        tokenId == 4224 || // Olgrem
        tokenId == 4581 || // Ikarus
        tokenId == 4841 || // Nerol
        tokenId == 5060 || // The Holy Light Spirit
        tokenId == 5546); // Zelemor
}

interface BcgTokenStakeListener {
    function onTokenStaked(address staker, uint256 tokenId) external;

    function onTokenUnstaked(address staker, uint256 tokenId) external;
}

/**
 * Invariants:
 * 1. lastCollectionTimestamp >= startTimestamp for every staked token.
 * 2. daysCollected <= VESTING_PERIOD_IN_DAYS always.
 * 3. For each active vesting period:
 *    3a. lastCollectionTimestamp is weakly increasing by exact full days.
 *    3b. daysCollected increment since last vesting period equals exactly
 *        (lastCollectionTimestamp - startTimestamp) / 1 day
 *
 * The contract ensures these invariants by:
 * - Setting both timestamps at the same moment on stake.
 * - Incrementing daysCollected by exact full days during collections.
 * - Preventing lastCollectionTimestamp from decreasing during reward collection.
 * - Calculating daysCollected based on the exact timestamp difference.
 */
contract BcgVesting is AccessControl, BcgTokenStakeListener {
    bytes32 public constant STAKER_ROLE = keccak256("STAKER_ROLE");

    // A linear vesting schedule, unlocked daily...
    uint256 public constant VESTING_PERIOD = 52 weeks;
    // ...which is 364 days in total...
    uint256 public constant VESTING_PERIOD_IN_DAYS = VESTING_PERIOD / 1 days;
    // ...and with a 50% initial unlock.
    uint256 public constant INITIAL_UNLOCK_BPS = 5000;

    // Unique (1/1) beras receive x10 the allocation of a regular bera.
    uint256 public constant UNIQUE_BERA_ALLOC_RATIO = 10;

    // 6117
    uint256 constant BASE_BERA_ALLOC_UNITS =
        (BCG_TOKEN_COUNT - UNIQUE_BERA_COUNT) +
            ((UNIQUE_BERA_COUNT * UNIQUE_BERA_ALLOC_RATIO));

    // Full 34 BERAMO tokens unlocked per day per bera
    uint256 public constant BASE_BERA_DAILY_UNLOCK = 34e18;
    // The total amount of tokens allocated for the linear vesting pool,
    // not accounting for the initial unlock.
    uint256 public constant LINEAR_UNLOCK_TOTAL =
        BASE_BERA_DAILY_UNLOCK * BASE_BERA_ALLOC_UNITS * VESTING_PERIOD_IN_DAYS;

    // The total amount of tokens unlocked at the start, calculated as a X% of the total pool.
    uint256 public constant INITIAL_UNLOCK_TOTAL =
        (LINEAR_UNLOCK_TOTAL * INITIAL_UNLOCK_BPS) / (10_000 - INITIAL_UNLOCK_BPS);
    // The amount of tokens unlocked at the start for a single base bera.
    uint256 public constant BASE_BERA_INITIAL_UNLOCK =
        INITIAL_UNLOCK_TOTAL / BASE_BERA_ALLOC_UNITS;

    // The expected total amount of tokens allocated to the users.
    // This should amount to roughly 15.14% of the initial token supply (of 1 billion)
    // (verified at runtime below)
    uint256 public constant VESTING_POOL_TOTAL = 151407984000000000000000000;

    // Address of the $BERAMO token (18 decimals)
    IERC20 public immutable _beramoToken;

    // Whether the funds have been transferred to the contract
    bool vestingPoolInitialized;

    /**
     * Invariant: daysCollected <= VESTING_PERIOD_IN_DAYS (364) always.
     * We only ever increment daysCollected by exact full days of pending rewards
     * (which can never exceed the vesting period), so this invariant is maintained.
     * Invariant: initialUnlockCollected is set to true iff the initial unlock
     * has been collected, which happens immediately during the first stake.
     */
    struct TokenVestingState {
        uint16 daysCollected;
        bool initialUnlockCollected;
        VestingPeriod vesting;
    }

    /**
     * Invariants:
     * 1. lastCollectionTimestamp >= startTimestamp for every staked token.
     * 2. Either all values are zero, or all are non-zero (i.e. vesting period is active).
     * 3. Values are zero if and only if the token is not staked.
     * 4. lastCollectionTimestamp is weakly increasing by exact full days.
     * 5. During an active vesting period, owner is set exactly once, initially.
     *
     * We maintain these invariants by:
     * - Setting both timestamps at the same moment on stake.
     * - Only ever incrementing lastCollectionTimestamp by full days.
     * - Resetting the vesting schedule on unstake.
     *
     * Notes:
     * - We use 48-bit timestamps, which are sufficient for million+ years.
     * - This is done to pack the struct into a single slot.
     */
    struct VestingPeriod {
        // The owner of the token who initiated the given vesting period
        address owner;
        uint48 startTimestamp;
        uint48 lastCollectionTimestamp;
    }
    // Token-based vesting schedules
    mapping(uint16 => TokenVestingState) public vestingState;

    constructor(IERC20 beramoToken, address stakeController) {
        // We can't verify this reliably at compile-time, so make sure the total
        // rewards pool size roughly corresponds to the 15.14% of the initial supply
        // of 1 billion, using the constants defined above.
        require(
            INITIAL_UNLOCK_TOTAL + LINEAR_UNLOCK_TOTAL == VESTING_POOL_TOTAL,
            VestingPoolInvalidSize()
        );
        // Sanity check that the picked daily rewards value is correct
        require(
            LINEAR_UNLOCK_TOTAL == 75703992000000000000000000,
            VestingPoolInvalidSize()
        );

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(STAKER_ROLE, stakeController);

        _beramoToken = beramoToken;
    }

    /**
     * Initializes the vesting pool by transferring the initial required amount of tokens.
     * @dev Can only be called by the contract owner.
     */
    function initializeVestingPool() external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(!vestingPoolInitialized, VestingPoolAlreadyInitialized());

        // We transfer at once the total amount of tokens required by the vesting pool
        _beramoToken.safeTransferFrom(msg.sender, address(this), VESTING_POOL_TOTAL);

        vestingPoolInitialized = true;
    }

    /**
     * Returns the total pending rewards for a given BCG token ID.
     * This includes the initial unlock (happens on stake) and the linear rewards.
     * @param tokenId BCG token ID to query.
     */
    function pendingRewards(uint16 tokenId) public view returns (uint256) {
        uint256 rewards = 0;

        // Account for the initial unlock if it hasn't been collected yet
        // (this can only happen before the token is staked)
        if (vestingState[tokenId].initialUnlockCollected == false) {
            rewards += BASE_BERA_INITIAL_UNLOCK * _allocationMultiplier(tokenId);
        }
        // Account for the linear rewards
        (, uint256 linearRewards) = _pendingLinearRewards(tokenId);
        rewards += linearRewards;

        return rewards;
    }

    /**
     * @notice Returns the pending rewards for multiple token IDs.
     * Does not verify if the token IDs are unique.
     * @dev This is simply a convenience function for the frontend to avoid having to multicall.
     * @param tokenIds The token IDs to query the pending rewards for.
     * @return rewards The pending rewards for each token ID.
     */
    function pendingRewardsBatch(
        uint16[] calldata tokenIds
    ) external view returns (uint256[] memory rewards) {
        rewards = new uint256[](tokenIds.length);

        for (uint256 i = 0; i < tokenIds.length; i++) {
            rewards[i] = pendingRewards(tokenIds[i]);
        }
    }

    /**
     * @notice Returns the total pending rewards for multiple token IDs.
     * Does not verify if the token IDs are unique.
     * @dev This is simply a convenience function for the frontend to avoid having to multicall.
     * @param tokenIds The token IDs to query the pending rewards for.
     * @return rewards The pending rewards for each token ID.
     */
    function pendingRewardsBatchTotal(
        uint16[] calldata tokenIds
    ) external view returns (uint256) {
        uint256 rewards = 0;
        for (uint256 i = 0; i < tokenIds.length; i++) {
            rewards += pendingRewards(tokenIds[i]);
        }
        return rewards;
    }

    /**
     * Perform bookkeeping for a freshly staked token.
     * @dev This is invoked by the stake controller when a token is staked.
     */
    function onTokenStaked(
        address staker,
        uint256 tokenId_
    ) external onlyRole(STAKER_ROLE) validateBcgTokenId(tokenId_) {
        // Truncation: validated to be in range by the modifier
        uint16 tokenId = uint16(tokenId_);
        TokenVestingState memory data = vestingState[tokenId];

        require(data.vesting.owner == address(0), TokenAlreadyStaked(tokenId));
        require(data.vesting.startTimestamp == 0, TokenAlreadyStaked(tokenId));
        require(data.vesting.lastCollectionTimestamp == 0, TokenAlreadyStaked(tokenId));

        // Collect the initial unlock immediately, if applicable
        if (data.initialUnlockCollected == false) {
            vestingState[tokenId].initialUnlockCollected = true;

            // Safety: The token address is immutable and picked by the creator,
            // so no risk of reentrancy.
            _beramoToken.safeTransfer(
                staker,
                BASE_BERA_INITIAL_UNLOCK * _allocationMultiplier(tokenId)
            );
        }

        // Nothing to unlock anymore, don't bother writing to storage
        if (data.daysCollected >= VESTING_PERIOD_IN_DAYS) {
            return;
        }

        // Otherwise, the user can still unlock some tokens and is not staking
        // yet, so we (re-)start the vesting schedule
        // Truncation: 48-bit timestamp is million years away
        uint48 _now = uint48(block.timestamp);

        vestingState[tokenId].vesting = VestingPeriod({
            owner: staker,
            startTimestamp: _now,
            // Invariant: lastCollectionTimestamp >= startTimestamp
            lastCollectionTimestamp: _now
        });
    }

    /**
     * Clear the staking schedule and collect any pending rewards.
     * @dev This is invoked by the stake controller when a token is unstaked.
     * @param tokenId_ The ID of the token being unstaked.
     */
    function onTokenUnstaked(
        address /* staker */,
        uint256 tokenId_
    ) external onlyRole(STAKER_ROLE) validateBcgTokenId(tokenId_) {
        // Truncation: validated to be in range by the modifier
        uint16 tokenId = uint16(tokenId_);
        TokenVestingState memory data = vestingState[tokenId];

        // Nothing to unlock anymore, don't bother writing to storage
        if (data.daysCollected >= VESTING_PERIOD_IN_DAYS) {
            return;
        }

        // There may be some rewards to collect, attempt to do that
        collectPendingRewards(tokenId);

        // Reset the vesting schedule
        vestingState[tokenId].vesting = VestingPeriod({
            owner: address(0),
            startTimestamp: 0,
            lastCollectionTimestamp: 0
        });
    }

    /**
     * @notice Collects pending linear rewards for a given token ID.
     * @dev Can be called by the token owner or an account with the STAKER_ROLE.
     * First, we must initialize the contract using `initializeVestingPool`.
     * The initial unlock is always collected first when staking, so we never
     * need to account for it here.
     * @param tokenId The ID of the token to collect rewards for.
     */
    function collectPendingRewards(uint16 tokenId) public validateBcgTokenId(tokenId) {
        require(vestingPoolInitialized, VestingPoolNotInitialized());

        TokenVestingState memory data = vestingState[tokenId];

        // Only the owner of the staked token or the staker can collect the rewards
        require(msg.sender == data.vesting.owner || hasRole(STAKER_ROLE, msg.sender));

        (uint256 fullDays, uint256 linearRewards) = _pendingLinearRewards(tokenId);
        if (linearRewards > 0) {
            vestingState[tokenId].daysCollected += uint16(fullDays);
            // The full days are calculated relative to the lastCollectionTimestamp,
            // so collecting mid-day will not impact the schedule
            vestingState[tokenId].vesting.lastCollectionTimestamp += uint48(
                fullDays * 1 days
            );

            // Safety: The token address is immutable and picked by the creator,
            // so no risk of reentrancy.
            _beramoToken.safeTransfer(data.vesting.owner, linearRewards);
        }
    }

    /**
     * @notice Collects pending linear rewards in a batch for given token IDs.
     * @dev This is a convenience function; we do not aim to optimize gas
     * not to duplicate core logic and the repeatedly touched memory slots will
     * be warm and so the savings would be miniscule.
     */
    function collectPendingRewardsBatch(uint16[] calldata tokenIds) public {
        uint16 tokenId;
        for (uint256 i = 0; i < tokenIds.length; i++) {
            tokenId = tokenIds[i];
            require(tokenId < BCG_TOKEN_COUNT, InvalidTokenId(tokenId));

            collectPendingRewards(tokenId);
        }
    }

    error TokenAlreadyStaked(uint16 tokenId);
    error InvalidTokenId(uint256 tokenId);
    error VestingPoolAlreadyInitialized();
    error VestingPoolNotInitialized();
    error VestingPoolInvalidSize();

    /** Computes the full days (units) of pending rewards and their total amount. */
    function _pendingLinearRewards(
        uint16 tokenId
    ) internal view returns (uint256 fullDays, uint256 rewards) {
        TokenVestingState memory data = vestingState[uint16(tokenId)];

        // Nothing to unlock anymore
        if (data.daysCollected >= VESTING_PERIOD_IN_DAYS) {
            return (0, 0);
        }

        // Not staking, so no rewards to collect
        if (data.vesting.startTimestamp == 0) {
            return (0, 0);
        }

        // According to the Ethereum Yellow Paper, block.timestamp increases monotonically.
        // Reference: https://ethereum.github.io/yellowpaper/paper.pdf (Section 4.4.3)
        // In proof-of-stake networks, block timestamps are agreed upon by validators
        // and provide reliable timekeeping.
        // Truncation: 48-bit timestamp is million years away
        uint48 _now = uint48(block.timestamp);

        fullDays = _fullDaysElapsed(data.vesting.lastCollectionTimestamp, _now);
        if (fullDays > 0) {
            // Ensure we never go beyond the vesting period (364 days)
            fullDays = (data.daysCollected + fullDays) > VESTING_PERIOD_IN_DAYS
                ? VESTING_PERIOD_IN_DAYS - data.daysCollected
                : fullDays;

            rewards = fullDays * BASE_BERA_DAILY_UNLOCK * _allocationMultiplier(tokenId);

            return (fullDays, rewards);
        }

        return (fullDays, 0);
    }

    modifier validateBcgTokenId(uint256 tokenId) {
        // Token IDs are 0-based, hence the strict inequality
        require(tokenId < BCG_TOKEN_COUNT, InvalidTokenId(tokenId));
        _;
    }

    function _allocationMultiplier(uint16 tokenId) internal pure returns (uint256) {
        return isUnique(tokenId) ? UNIQUE_BERA_ALLOC_RATIO : 1;
    }

    function _fullDaysElapsed(
        uint256 start,
        uint256 end
    ) internal pure returns (uint256) {
        // By default truncated towards zero
        return (end - start) / 1 days;
    }
}
