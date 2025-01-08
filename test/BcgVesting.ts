import { time, loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { ethers } from "hardhat";
import { expect } from "chai";

const DAYS_IN_SECONDS = 24 * 60 * 60;

describe("BcgVesting", function () {
  async function deployContractsFixture() {
    const [owner, staker, otherAccount] = await ethers.getSigners();

    // Deploy mock ERC20 token
    const ERC20Token = await ethers.getContractFactory("TestErc20");
    const erc20Token = await ERC20Token.deploy(owner.address);
    await erc20Token.waitForDeployment();

    await erc20Token.connect(owner).mint(owner, 1_000_000_000n * 10n ** 18n);

    const tokenAddress = await erc20Token.getAddress();

    // Deploy BcgVesting contract
    const BcgVesting = await ethers.getContractFactory("BcgVesting");
    const bcgVesting = await BcgVesting.deploy(tokenAddress, staker.address);
    const vestingAddress = await bcgVesting.getAddress();

    // Transfer VESTING_POOL_TOTAL tokens to BcgVesting contract
    const VESTING_POOL_TOTAL = await bcgVesting.VESTING_POOL_TOTAL();
    await erc20Token.connect(owner).approve(vestingAddress, VESTING_POOL_TOTAL);
    await bcgVesting.initializeVestingPool();
    expect(await erc20Token.balanceOf(vestingAddress)).to.equal(VESTING_POOL_TOTAL);

    return { owner, staker, otherAccount, erc20Token, bcgVesting };
  }

  it("Should deploy and set the correct VESTING_POOL_TOTAL", async function () {
    const { bcgVesting } = await loadFixture(deployContractsFixture);
    const VESTING_POOL_TOTAL = await bcgVesting.VESTING_POOL_TOTAL();
    expect(VESTING_POOL_TOTAL).to.be.a("bigint");
  });

  it("Should allow staking a valid token ID", async function () {
    const { staker, bcgVesting } = await loadFixture(deployContractsFixture);

    for (const tokenId of [0, 1, 100, 1500, 5999]) {
      await expect(bcgVesting.connect(staker).onTokenStaked(staker.address, tokenId)).to
        .not.be.reverted;
    }
  });

  it("Should not allow staking an invalid token ID", async function () {
    const { staker, bcgVesting } = await loadFixture(deployContractsFixture);

    const invalidTokenId = 6000; // Invalid token ID
    await expect(
      bcgVesting.connect(staker).onTokenStaked(staker.address, invalidTokenId)
    ).to.be.revertedWithCustomError(bcgVesting, "InvalidTokenId");
  });

  it("Should not allow staking the same token twice", async function () {
    const { staker, bcgVesting } = await loadFixture(deployContractsFixture);

    const tokenId = 100;
    await bcgVesting.connect(staker).onTokenStaked(staker.address, tokenId);
    await expect(
      bcgVesting.connect(staker).onTokenStaked(staker.address, tokenId)
    ).to.be.revertedWithCustomError(bcgVesting, "TokenAlreadyStaked");
  });

  it("Should calculate pending rewards correctly", async function () {
    const { staker, bcgVesting, erc20Token } = await loadFixture(deployContractsFixture);

    const tokenId = 100;
    await bcgVesting.connect(staker).onTokenStaked(staker.address, tokenId);

    await time.increase(10 * DAYS_IN_SECONDS);

    const pendingRewards = await bcgVesting.pendingRewards(tokenId);
    const BASE_BERA_DAILY_UNLOCK = await bcgVesting.BASE_BERA_DAILY_UNLOCK();

    expect(pendingRewards).to.equal(BASE_BERA_DAILY_UNLOCK * 10n);

    // Unstake the token to collect rewards
    const stakerBalanceBefore = await erc20Token.balanceOf(staker.address);
    await bcgVesting.connect(staker).onTokenUnstaked(staker.address, tokenId);
    const stakerBalanceAfter = await erc20Token.balanceOf(staker.address);

    expect(stakerBalanceAfter - stakerBalanceBefore).to.equal(pendingRewards);
  });

  it("Should not transfer rewards if there are none", async function () {
    const { staker, bcgVesting, erc20Token } = await loadFixture(deployContractsFixture);

    const tokenId = 100;
    await bcgVesting.connect(staker).onTokenStaked(staker.address, tokenId);

    // Immediately unstake
    const stakerBalanceBefore = await erc20Token.balanceOf(staker.address);
    await bcgVesting.connect(staker).onTokenUnstaked(staker.address, tokenId);
    const stakerBalanceAfter = await erc20Token.balanceOf(staker.address);

    // No rewards should be transferred
    expect(stakerBalanceAfter - stakerBalanceBefore).to.equal(0);
  });

  it("Should handle unique Bera rewards correctly", async function () {
    const { staker, bcgVesting, erc20Token } = await loadFixture(deployContractsFixture);

    const uniqueTokenId = 931; // Unique Bera token ID
    await bcgVesting.connect(staker).onTokenStaked(staker.address, uniqueTokenId);

    await time.increase(5 * DAYS_IN_SECONDS);

    const pendingRewards = await bcgVesting.pendingRewards(uniqueTokenId);
    const BASE_BERA_DAILY_UNLOCK = await bcgVesting.BASE_BERA_DAILY_UNLOCK();
    const UNIQUE_BERA_ALLOC_RATIO = await bcgVesting.UNIQUE_BERA_ALLOC_RATIO();

    expect(pendingRewards).to.equal(
      BASE_BERA_DAILY_UNLOCK * 5n * UNIQUE_BERA_ALLOC_RATIO
    );

    // Unstake the token to collect rewards
    const stakerBalanceBefore = await erc20Token.balanceOf(staker.address);
    await bcgVesting.connect(staker).onTokenUnstaked(staker.address, uniqueTokenId);
    const stakerBalanceAfter = await erc20Token.balanceOf(staker.address);

    expect(stakerBalanceAfter - stakerBalanceBefore).to.equal(pendingRewards);
  });

  it("Should not allow non-staker role to call staking functions", async function () {
    const { otherAccount, bcgVesting } = await loadFixture(deployContractsFixture);

    const tokenId = 100;
    await expect(
      bcgVesting.connect(otherAccount).onTokenStaked(otherAccount.address, tokenId)
    ).to.be.revertedWithCustomError(bcgVesting, "AccessControlUnauthorizedAccount");
  });

  it("Should not allow non-owner to call initializeVestingPool", async function () {
    const { otherAccount, bcgVesting } = await loadFixture(deployContractsFixture);

    await expect(
      bcgVesting.connect(otherAccount).initializeVestingPool()
    ).to.be.revertedWithCustomError(bcgVesting, "AccessControlUnauthorizedAccount");
  });

  it("Only the staker or respective owner can collect rewards", async function () {
    const { staker, otherAccount, bcgVesting, erc20Token } = await loadFixture(
      deployContractsFixture
    );

    const tokenId = 100;
    await bcgVesting.connect(staker).onTokenStaked(staker.address, tokenId);

    await time.increase(5 * DAYS_IN_SECONDS);

    const pendingRewards = await bcgVesting.pendingRewards(tokenId);
    const BASE_BERA_DAILY_UNLOCK = await bcgVesting.BASE_BERA_DAILY_UNLOCK();

    expect(pendingRewards).to.equal(BASE_BERA_DAILY_UNLOCK * 5n);

    // Only the staker can collect rewards
    await expect(
      bcgVesting.connect(otherAccount).onTokenUnstaked(otherAccount.address, tokenId)
    ).to.be.revertedWithCustomError(bcgVesting, "AccessControlUnauthorizedAccount");

    // Staker can collect rewards
    const stakerBalanceBefore = await erc20Token.balanceOf(staker.address);
    await bcgVesting.connect(staker).onTokenUnstaked(staker.address, tokenId);
    const stakerBalanceAfter = await erc20Token.balanceOf(staker.address);

    expect(stakerBalanceAfter - stakerBalanceBefore).to.equal(pendingRewards);
  });

  it.skip("Should fully deplete the pending rewards on unstake", async function () {
    const { staker, bcgVesting, erc20Token } = await loadFixture(deployContractsFixture);

    const tokenId = 100;
    await bcgVesting.connect(staker).onTokenStaked(staker.address, tokenId);

    await time.increase(100 * DAYS_IN_SECONDS);

    const pendingRewards = await bcgVesting.pendingRewards(tokenId);
    const BASE_BERA_DAILY_UNLOCK = await bcgVesting.BASE_BERA_DAILY_UNLOCK();

    expect(pendingRewards).to.equal(BASE_BERA_DAILY_UNLOCK * 100n);

    // Unstake the token to collect rewards
    const stakerBalanceBefore = await erc20Token.balanceOf(staker.address);
    await bcgVesting.connect(staker).onTokenUnstaked(staker.address, tokenId);
    const stakerBalanceAfter = await erc20Token.balanceOf(staker.address);

    expect(stakerBalanceAfter - stakerBalanceBefore).to.equal(pendingRewards);

    // Rewards pool should be depleted
    expect(await bcgVesting.pendingRewards(tokenId)).to.equal(0);
  });

  it.skip("Fully unstaking every token should exactly deplete the rewards pool", async function () {
    const { staker, bcgVesting, erc20Token } = await loadFixture(deployContractsFixture);

    const stakerBalanceInitial = await erc20Token.balanceOf(staker.address);
    expect(stakerBalanceInitial).to.equal(0);

    const allTokenIds = Array.from({ length: 6000 }).map((_, i) => i);
    for (const tokenId of allTokenIds) {
      await bcgVesting.connect(staker).onTokenStaked(staker.address, tokenId);
    }

    // See if we completely collected the initial rewards
    const stakerBalanceBefore = await erc20Token.balanceOf(staker.address);
    const INITIAL_UNLOCK_TOTAL = await bcgVesting.INITIAL_UNLOCK_TOTAL();
    expect(stakerBalanceBefore).to.equal(INITIAL_UNLOCK_TOTAL);

    // Simulate 364 days passing
    await time.increase(364 * DAYS_IN_SECONDS);

    const VESTING_POOL_TOTAL = await bcgVesting.VESTING_POOL_TOTAL();

    // Unstake all tokens to collect rewards
    for (const tokenId of allTokenIds) {
      await bcgVesting.connect(staker).onTokenUnstaked(staker.address, tokenId);
    }
    const stakerBalanceAfter = await erc20Token.balanceOf(staker.address);

    const LINEAR_UNLOCK_TOTAL = await bcgVesting.LINEAR_UNLOCK_TOTAL();
    expect(stakerBalanceAfter - stakerBalanceBefore).to.equal(LINEAR_UNLOCK_TOTAL);

    expect(INITIAL_UNLOCK_TOTAL + LINEAR_UNLOCK_TOTAL).to.equal(VESTING_POOL_TOTAL);
    // Rewards pool should be depleted
    expect(await erc20Token.balanceOf(await bcgVesting.getAddress())).to.equal(0);
  });

  it("Should grant the initial unlock on the first stake", async function () {
    const { staker, bcgVesting, erc20Token } = await loadFixture(deployContractsFixture);

    const tokenId = 42;
    const stakerBalanceBefore = await erc20Token.balanceOf(staker.address);

    // First time staking this token
    await bcgVesting.connect(staker).onTokenStaked(staker.address, tokenId);

    const stakerBalanceAfter = await erc20Token.balanceOf(staker.address);

    // Expect that initial unlock has occurred
    expect(stakerBalanceAfter).to.be.gt(stakerBalanceBefore);

    // Check that initialUnlockCollected is now true
    const vestingState = await bcgVesting.vestingState(tokenId);
    const initialUnlockCollected = vestingState[1];
    expect(initialUnlockCollected).to.be.true;
  });

  it("Should maintain daysCollected consistent with timestamps", async function () {
    const { staker, bcgVesting } = await loadFixture(deployContractsFixture);

    const tokenId = 100;
    await bcgVesting.connect(staker).onTokenStaked(staker.address, tokenId);
    const initialState = await bcgVesting.vestingState(tokenId);
    const startTimestamp = initialState.lastCollectionTimestamp;

    // First collection after 2 days
    await time.increase(2 * DAYS_IN_SECONDS);
    await bcgVesting.connect(staker).collectPendingRewards(tokenId);

    // Second collection after 1 more day
    await time.increase(1 * DAYS_IN_SECONDS);
    await bcgVesting.connect(staker).collectPendingRewards(tokenId);

    // Third collection after 1 more day
    await time.increase(1 * DAYS_IN_SECONDS);
    await bcgVesting.connect(staker).collectPendingRewards(tokenId);

    // Verify that daysCollected exactly matches the days between timestamps
    const state = await bcgVesting.vestingState(tokenId);
    const { daysCollected, lastCollectionTimestamp } = state;

    expect(daysCollected).to.equal(
      Math.floor(Number(lastCollectionTimestamp - startTimestamp) / DAYS_IN_SECONDS),
      "daysCollected must exactly match days between lastCollectionTimestamp and startTimestamp"
    );
  });

  it("Should not grant the initial unlock on subsequent stakes", async function () {
    const { staker, bcgVesting, erc20Token } = await loadFixture(deployContractsFixture);

    const tokenId = 100;
    const stakerBalanceBeforeFirst = await erc20Token.balanceOf(staker.address);

    // First stake: initial unlock granted
    await bcgVesting.connect(staker).onTokenStaked(staker.address, tokenId);
    const stakerBalanceAfterFirst = await erc20Token.balanceOf(staker.address);
    expect(stakerBalanceAfterFirst).to.be.gt(stakerBalanceBeforeFirst);

    // Unstake the token
    await bcgVesting.connect(staker).onTokenUnstaked(staker.address, tokenId);

    const stakerBalanceBeforeSecond = await erc20Token.balanceOf(staker.address);

    // Stake again: no additional initial unlock should be granted this time
    await bcgVesting.connect(staker).onTokenStaked(staker.address, tokenId);
    const stakerBalanceAfterSecond = await erc20Token.balanceOf(staker.address);

    // Should not change from before second stake
    expect(stakerBalanceAfterSecond).to.equal(stakerBalanceBeforeSecond);

    // Check that initialUnlockCollected remains true
    const vestingState = await bcgVesting.vestingState(tokenId);
    const initialUnlockCollected = vestingState[1];
    expect(initialUnlockCollected).to.be.true;
  });

  it("Should allow batch collecting pending rewards for multiple tokens", async function () {
    const { staker, bcgVesting, erc20Token } = await loadFixture(deployContractsFixture);

    const tokenIds = [10, 20, 30]; // A few arbitrary valid token IDs
    for (const tokenId of tokenIds) {
      await bcgVesting.connect(staker).onTokenStaked(staker.address, tokenId);
    }

    await time.increase(7 * DAYS_IN_SECONDS);

    // Calculate expected pending rewards for each token
    let totalExpectedRewards = 0n;
    for (const tokenId of tokenIds) {
      // All these tokens are non-unique for simplicity
      const pendingRewards = await bcgVesting.pendingRewards(tokenId);
      totalExpectedRewards += pendingRewards;
    }

    const stakerBalanceBefore = await erc20Token.balanceOf(staker.address);
    await bcgVesting.connect(staker).collectPendingRewardsBatch(tokenIds);
    const stakerBalanceAfter = await erc20Token.balanceOf(staker.address);

    // Check that the staker's balance increased by the total expected rewards
    expect(stakerBalanceAfter - stakerBalanceBefore).to.equal(totalExpectedRewards);

    // Subsequent collections should yield zero since rewards have been collected
    const stakerBalanceBeforeSecond = await erc20Token.balanceOf(staker.address);
    await bcgVesting.connect(staker).collectPendingRewardsBatch(tokenIds);
    const stakerBalanceAfterSecond = await erc20Token.balanceOf(staker.address);
    expect(stakerBalanceAfterSecond - stakerBalanceBeforeSecond).to.equal(0);

    // Ensure that individual pending rewards are zero
    for (const tokenId of tokenIds) {
      // All these tokens are non-unique for simplicity
      const pendingRewards = await bcgVesting.pendingRewards(tokenId);
      expect(pendingRewards).to.be.equal(0);
    }
  });

  it("Should revert when passing an invalid token ID to batch collection", async function () {
    const { staker, bcgVesting } = await loadFixture(deployContractsFixture);

    const validTokenId = 100;
    await bcgVesting.connect(staker).onTokenStaked(staker.address, validTokenId);

    const invalidTokenId = 6000; // Out of range
    await expect(
      bcgVesting
        .connect(staker)
        .collectPendingRewardsBatch([validTokenId, invalidTokenId])
    ).to.be.revertedWithCustomError(bcgVesting, "InvalidTokenId");
  });

  it("Should do nothing when called with an empty array", async function () {
    const { staker, bcgVesting, erc20Token } = await loadFixture(deployContractsFixture);

    const tokenId = 200;
    await bcgVesting.connect(staker).onTokenStaked(staker.address, tokenId);

    await time.increase(5 * DAYS_IN_SECONDS);

    const pendingRewardsBefore = await bcgVesting.pendingRewards(tokenId);
    const stakerBalanceBefore = await erc20Token.balanceOf(staker.address);

    // Call batch collect with empty array
    await bcgVesting.connect(staker).collectPendingRewardsBatch([]);

    // Nothing should have changed
    const pendingRewardsAfter = await bcgVesting.pendingRewards(tokenId);
    const stakerBalanceAfter = await erc20Token.balanceOf(staker.address);

    expect(pendingRewardsAfter).to.equal(pendingRewardsBefore);
    expect(stakerBalanceAfter).to.equal(stakerBalanceBefore);
  });

  it("Should allow batch read of pending rewards", async function () {
    const { staker, bcgVesting, erc20Token } = await loadFixture(deployContractsFixture);

    const tokenIds = [5, 12, 8]; // A few arbitrary valid token IDs
    for (const tokenId of tokenIds) {
      await bcgVesting.connect(staker).onTokenStaked(staker.address, tokenId);

      await time.increase(10 * DAYS_IN_SECONDS);
    }

    const pendingRewards = await bcgVesting.pendingRewardsBatch(tokenIds);
    const BASE_BERA_DAILY_UNLOCK = await bcgVesting.BASE_BERA_DAILY_UNLOCK();

    expect(pendingRewards[0]).to.equal(BASE_BERA_DAILY_UNLOCK * 30n);
    expect(pendingRewards[1]).to.equal(BASE_BERA_DAILY_UNLOCK * 20n);
    expect(pendingRewards[2]).to.equal(BASE_BERA_DAILY_UNLOCK * 10n);
  });

  it("Should allow batch read of pending rewards total", async function () {
    const { staker, bcgVesting, erc20Token } = await loadFixture(deployContractsFixture);
    const tokenIds = [5, 12, 8]; // A few arbitrary valid token IDs
    for (const tokenId of tokenIds) {
      await bcgVesting.connect(staker).onTokenStaked(staker.address, tokenId);

      await time.increase(10 * DAYS_IN_SECONDS);
    }

    const pendingRewards = await bcgVesting.pendingRewardsBatchTotal(tokenIds);
    const BASE_BERA_DAILY_UNLOCK = await bcgVesting.BASE_BERA_DAILY_UNLOCK();

    expect(pendingRewards).to.equal(BASE_BERA_DAILY_UNLOCK * 60n);
  });
});
