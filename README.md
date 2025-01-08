# BcgVesting (audit)

## Overview

We are Beramonium, an OG NFT (GameFi) project on Berachain. Right now, we are expanding our on-chain infra beyond the original ERC-721 collection with a planned ERC-20 ($BERAMO) to be used in-game.

An integral part of that is the vesting schedule for $BERAMO but distributed to the NFT holders that stake their tokens, which is what we want to audit now.

The smart contract subject to audit can be found at [src/BcgVesting.sol](src/BcgVesting.sol) and has the following properties:

- the contract is not upgradable
- the vesting schedule consists of an initial unlock followed up by a linear unlock with a day granularity (52 weeks)
- collecting rewards happens automatically when unstaking a token (or when staking the token for the first time)
- NFT owners can directly collect unlocked rewards themselves on-demand

The contract is designed to be self-contained and so it will be interacted with:

1. by the external NFT staking contract via on-chain callbacks
2. (optionally) by the NFT holders that wish to gradually claim the unlocked allocation.

To illustrate:

```
[ NFT Holder ] -> (stake NFT) -> [ Staking Contract ] -> (callback) -> [ BcgVesting ]

[ BcgVesting ] -> (ERC20 transfer) -> [ Staker / NFT Holder ]
```

See [Key Properties and Invariants](#key-properties-and-invariants) below for a more detailed description of the properties.

## Resources

To facilitate the review, we separated a repository together with tests that we used internally during development.

This is a combined Hardhat/Foundry project and has Hardhat-style unit tests and Foundry-style invariant tests,
executed using `npx hardhat test` and `forge test -vvv`, respectively.

### Structure

- [src](src): Contains the Solidity source code.
- [test](test): Contains the Solidity tests.
- [scripts](scripts): Contains the deployment script for the vesting contract.

### Contracts

- [src/BcgVesting.sol](src/BcgVesting.sol): The vesting contract (subject to audit).

- [src/Beramonium.sol](src/Beramonium.sol): The original ERC-721 contract.
- [src/BeramoniumGemhuntersListeners.sol](src/BeramoniumGemhuntersListeners.sol): The NFT staking contract with on-chain callbacks (upgradeable via UUPS).
- [src/BeramoniumToken.sol](src/BeramoniumToken.sol): The ERC-20 token (dummy).

- [src/{Uint13List,Uint13Array19}.sol](src/Uint13List.sol): A dynamic list of `uint13`s for each address, used for the staking contract.

## Key Properties and Invariants

### Roles

| Role             | Permissions                                                  |
|------------------|-------------------------------------------------------------|
| `DEFAULT_ADMIN`    | Can initialize the vesting pool, manage roles               |
| `STAKER_ROLE`      | Can trigger `onTokenStaked` / `onTokenUnstaked`                |
| Token Owner      | Can call `collectPendingRewards`, receive the ERC20 rewards   |


### Core Properties

1. **Vesting Schedule**

   - 50% initial unlock on first stake, automatically collected when staking the token for the first time
   - Linear daily unlock over 52 weeks (364 days)
   - Unique (1/1) Beras receive 10x allocation multiplier
   - Initial unlock is granted only once per token

2. **Access Control**
   - Only STAKER_ROLE (staking contract) can trigger stake/unstake callbacks
   - Only token owner or STAKER_ROLE can collect pending rewards for the token owner
     - the owner can directly call `collectPendingRewards` on the contract
     - the staking contract indirectly calls `collectPendingRewards` via the `onTokenUnstaked` callback
   - Only admin can initialize the vesting pool
3. **Token Balance**
   - Vesting pool is initialized exactly once with the exact total amount of tokens
   - Vesting pool will eventually be fully depleted to exactly zero

### Invariants

1. **Timestamp Consistency**

   - `lastCollectionTimestamp >= startTimestamp` for every staked token
   - Timestamps are updated atomically during stake/unstake operations
   - Collection timestamps only increment by full days
   - `lastCollectionTimestamp` is weakly increasing for each token
   - For each active vesting period, `daysCollected` increment always equals `(lastCollectionTimestamp - startTimestamp) / 1 day`

2. **Vesting Period Bounds**

   - `daysCollected <= VESTING_PERIOD_IN_DAYS` (364) always
   - Days collected increments only by exact full days
   - Cannot collect beyond vesting period

3. **State Consistency**
   - `VestingPeriod` values are either all zero or all non-zero
   - Zero values indicate unstaked state
   - Non-zero values indicate active staking period
   - During an active staking period, the owner address is set exactly once to the staker address

### Key Assumptions

1. **Time Handling**

   - Block timestamps increase monotonically
   - Timestamps assumed to not be manipulable in Proof-of-Stake
   - Uses 48-bit timestamps (sufficient for million+ years)
   - Day-based granularity for linear unlocks

2. **ERC-721 Token Properties**

   - Fixed supply of 6000 Beramonium (BCG) tokens
   - 13 unique (1/1) Beras with predefined, static IDs
   - Token IDs are 0-based and sequential

3. **ERC-20 Token Safety**

   - ERC-20 token address is immutable and trusted
   - No reentrancy risk in token transfers

4. **Staking Contract**
   - The staking contract is assumed to be trusted
     - specifically, we assume that it correctly checks for NFT ownership and staking status
   - Since it is upgradable, we assume that the upgrader is trusted
   - The staking contract will never be paused nor upgraded to a contract that does not call `onTokenStaked` and `onTokenUnstaked`

### Testing Coverage

The above properties are verified through:

- Hardhat unit tests for functional correctness
- Foundry invariant tests for property verification
- Deep fuzzing runs (10,000 depth) for edge cases (`daysCollected` saturation)
