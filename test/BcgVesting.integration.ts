import { time, loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { ethers, upgrades } from "hardhat";
import { expect } from "chai";

describe("BeramoniumGemhunters Integration", function () {
  async function deployFullSystemFixture() {
    const [deployer, userOne] = await ethers.getSigners();

    // Deploy ERC20 token
    const ERC20 = await ethers.getContractFactory("BeramoniumToken");
    const erc20 = await ERC20.deploy();
    await erc20.waitForDeployment();

    // Deploy Beramonium NFT
    const maxPerWalletPublic = 1000; // Increased to allow minting token 931
    const collectionSize = 6000;
    const price = ethers.parseEther("0.001");
    const startTime = Math.floor(Date.now() / 1000);
    const premintWallet = deployer;
    const premintAmount = 125;
    const baseTokenURI = "https://api.beramonium.io/api/v1/genesis/";

    const Beramonium = await ethers.getContractFactory("Beramonium");
    const beramonium = await Beramonium.deploy(
      maxPerWalletPublic,
      collectionSize,
      price,
      startTime,
      premintWallet,
      premintAmount,
      baseTokenURI
    );
    await beramonium.waitForDeployment();

    // Deploy Gemhunters
    const Gemhunters = await ethers.getContractFactory("BeramoniumGemhuntersListeners");
    const gemhunters = await upgrades.deployProxy(
      Gemhunters,
      [await beramonium.getAddress()],
      { kind: "uups" }
    );

    // Deploy BcgVesting
    const BcgVesting = await ethers.getContractFactory("BcgVesting");
    const bcgVesting = await BcgVesting.deploy(
      await erc20.getAddress(),
      await gemhunters.getAddress()
    );

    // Setup the system
    await beramonium.setApprovalForAll(gemhunters, true);

    const listenerParams = {
      addr: await bcgVesting.getAddress(),
      onStakedSelector: bcgVesting.interface.getFunction("onTokenStaked").selector,
      onUnstakedSelector: bcgVesting.interface.getFunction("onTokenUnstaked").selector,
      allowFail: false,
    };

    await gemhunters.pushListener(listenerParams);

    // Initialize vesting pool
    const vestingPoolTotal = await bcgVesting.VESTING_POOL_TOTAL();
    await erc20.approve(bcgVesting, vestingPoolTotal);
    await bcgVesting.initializeVestingPool();

    // Wait for public sale to start (tier 3)
    await time.increase(8 * 60 * 60); // 8 hours from start time

    // Mint some NFTs to userOne for testing
    const mintPrice = price * 5n; // Mint 5 NFTs
    await beramonium.connect(userOne).publicSaleMint(5, { value: mintPrice });

    return {
      deployer,
      userOne,
      erc20,
      beramonium,
      gemhunters,
      bcgVesting,
      price,
    };
  }

  it("Should execute staking flow with vesting rewards", async function () {
    const { userOne, erc20, beramonium, gemhunters, bcgVesting } = await loadFixture(
      deployFullSystemFixture
    );

    // Check initial balances
    const initialBalance = await erc20.balanceOf(userOne.address);
    expect(initialBalance).to.equal(0);

    // Approve and stake a token
    const tokenId = 125; // First token after premint
    await beramonium.connect(userOne).approve(gemhunters, tokenId);

    // Create token array for staking
    const tokenIds = [tokenId];
    await gemhunters.connect(userOne).stake(tokenIds);

    // Verify staking occurred
    expect(await beramonium.ownerOf(tokenId)).to.equal(await gemhunters.getAddress());

    // Should have received initial unlock amount
    const balanceAfterStake = await erc20.balanceOf(userOne.address);
    const expectedInitialUnlock = await bcgVesting.BASE_BERA_INITIAL_UNLOCK();
    expect(balanceAfterStake).to.equal(expectedInitialUnlock);

    // Move time forward
    await time.increase(30 * 24 * 60 * 60); // 30 days

    // Check pending rewards
    const pendingRewards = await bcgVesting.pendingRewards(tokenId);
    const BASE_BERA_DAILY_UNLOCK = await bcgVesting.BASE_BERA_DAILY_UNLOCK();
    expect(pendingRewards).to.equal(BASE_BERA_DAILY_UNLOCK * 30n);

    // Unstake the token
    await gemhunters.connect(userOne).unstakeByIndices([0]);

    // Verify final balance includes both initial unlock and accrued rewards
    const finalBalance = await erc20.balanceOf(userOne.address);
    expect(finalBalance).to.equal(expectedInitialUnlock + pendingRewards);
  });

  it("Should handle unique Bera staking with higher rewards", async function () {
    const { userOne, beramonium, erc20, gemhunters, bcgVesting, price } =
      await loadFixture(deployFullSystemFixture);

    // Mint enough tokens to get to 931 (accounting for premint)
    const tokensNeeded = 931 - 125 + 1;
    const mintPrice = price * BigInt(tokensNeeded);
    await beramonium.connect(userOne).publicSaleMint(tokensNeeded, { value: mintPrice });

    // Stake the unique Bera
    const uniqueTokenId = 931;
    await beramonium.connect(userOne).approve(gemhunters, uniqueTokenId);
    await gemhunters.connect(userOne).stake([uniqueTokenId]);

    // Move time forward
    await time.increase(10 * 24 * 60 * 60); // 10 days

    // Check pending rewards with unique multiplier
    const pendingRewards = await bcgVesting.pendingRewards(uniqueTokenId);
    const BASE_BERA_DAILY_UNLOCK = await bcgVesting.BASE_BERA_DAILY_UNLOCK();
    const UNIQUE_BERA_ALLOC_RATIO = await bcgVesting.UNIQUE_BERA_ALLOC_RATIO();
    const expectedInitialUnlock = await bcgVesting.BASE_BERA_INITIAL_UNLOCK();

    // For unique Beras, both the initial unlock and daily rewards are multiplied by UNIQUE_BERA_ALLOC_RATIO
    const expectedDailyRewards = BASE_BERA_DAILY_UNLOCK * 10n * UNIQUE_BERA_ALLOC_RATIO;
    expect(pendingRewards).to.equal(expectedDailyRewards);

    // Unstake and verify rewards
    await gemhunters.connect(userOne).unstakeByIndices([0]);
    const finalBalance = await erc20.balanceOf(userOne.address);

    // The final balance should include:
    // 1. Initial unlock * UNIQUE_BERA_ALLOC_RATIO
    // 2. Daily rewards * UNIQUE_BERA_ALLOC_RATIO
    const expectedTotalRewards =
      expectedInitialUnlock * UNIQUE_BERA_ALLOC_RATIO + expectedDailyRewards;
    expect(finalBalance).to.equal(expectedTotalRewards);
  });

  it("Should handle multiple stakes and unstakes correctly", async function () {
    const { userOne, beramonium, gemhunters, bcgVesting } = await loadFixture(
      deployFullSystemFixture
    );

    // Stake multiple tokens
    const tokenIds = [125, 126, 127]; // First tokens after premint
    for (const tokenId of tokenIds) {
      await beramonium.connect(userOne).approve(gemhunters, tokenId);
    }
    await gemhunters.connect(userOne).stake(tokenIds);

    // Move time forward
    await time.increase(15 * 24 * 60 * 60); // 15 days

    // Unstake in reverse order
    await gemhunters.connect(userOne).unstakeByIndices([2, 1, 0]);

    // Verify all tokens returned
    for (const tokenId of tokenIds) {
      expect(await beramonium.ownerOf(tokenId)).to.equal(userOne.address);
    }
  });

  // added

  it("Should handle the complete lifecycle with multiple tokens", async function () {
    const { userOne, beramonium, erc20, gemhunters, bcgVesting, price } =
      await loadFixture(deployFullSystemFixture);

    // Mint enough tokens including a unique one (931)
    const tokensNeeded = 931 - 125 + 1;
    const mintPrice = price * BigInt(tokensNeeded);
    await beramonium.connect(userOne).publicSaleMint(tokensNeeded, { value: mintPrice });

    // Stake multiple tokens: regular (500, 600) and unique (931)
    const tokenIds = [500, 600, 931];
    for (const tokenId of tokenIds) {
      await beramonium.connect(userOne).approve(gemhunters, tokenId);
    }
    await gemhunters.connect(userOne).stake(tokenIds);

    // Initial balance should include initial unlock for all tokens
    const BASE_BERA_INITIAL_UNLOCK = await bcgVesting.BASE_BERA_INITIAL_UNLOCK();
    const UNIQUE_BERA_ALLOC_RATIO = await bcgVesting.UNIQUE_BERA_ALLOC_RATIO();
    const expectedInitialUnlock =
      BASE_BERA_INITIAL_UNLOCK * 2n + // Regular tokens
      BASE_BERA_INITIAL_UNLOCK * UNIQUE_BERA_ALLOC_RATIO; // Unique token

    const balanceAfterStake = await erc20.balanceOf(userOne.address);
    expect(balanceAfterStake).to.equal(expectedInitialUnlock);

    // Time travel through multiple periods
    const BASE_BERA_DAILY_UNLOCK = await bcgVesting.BASE_BERA_DAILY_UNLOCK();

    // Test a single 30-day period instead
    await time.increase(30 * 24 * 60 * 60);

    // Check regular token rewards
    const pendingRewardsRegular = await bcgVesting.pendingRewards(tokenIds[0]);
    expect(pendingRewardsRegular).to.equal(BASE_BERA_DAILY_UNLOCK * 30n);

    // Check unique token rewards
    const pendingRewardsUnique = await bcgVesting.pendingRewards(tokenIds[2]); // 931
    expect(pendingRewardsUnique).to.equal(
      BASE_BERA_DAILY_UNLOCK * 30n * UNIQUE_BERA_ALLOC_RATIO
    );

    // Collect rewards and verify total
    await bcgVesting.connect(userOne).collectPendingRewardsBatch(tokenIds);
    const finalBalance = await erc20.balanceOf(userOne.address);

    // Total should include:
    // 1. Initial unlocks (2 regular + 1 unique)
    // 2. 30 days of rewards for 2 regular tokens
    // 3. 30 days of rewards for 1 unique token
    const expectedFinalBalance =
      expectedInitialUnlock + // Initial unlocks
      BASE_BERA_DAILY_UNLOCK * 30n * 2n + // Regular tokens rewards
      BASE_BERA_DAILY_UNLOCK * 30n * UNIQUE_BERA_ALLOC_RATIO; // Unique token rewards

    expect(finalBalance).to.equal(expectedFinalBalance);
  });

  it("Should maintain correct state after complex operations", async function () {
    const { userOne, beramonium, erc20, gemhunters, bcgVesting } = await loadFixture(
      deployFullSystemFixture
    );

    // Initial stake
    const tokenIds = [125, 126, 127];
    for (const tokenId of tokenIds) {
      await beramonium.connect(userOne).approve(gemhunters, tokenId);
    }
    await gemhunters.connect(userOne).stake(tokenIds);

    // Time travel and collect rewards midway
    await time.increase(15 * 24 * 60 * 60);
    await bcgVesting.connect(userOne).collectPendingRewardsBatch(tokenIds);

    // Unstake some tokens
    await gemhunters.connect(userOne).unstakeByIndices([1]); // Unstake middle token

    // Verify state
    const stakeCount = await gemhunters.stakedBeraCount(userOne.address);
    expect(stakeCount).to.equal(2);

    // Restake the token
    await beramonium.connect(userOne).approve(gemhunters, tokenIds[1]);
    await gemhunters.connect(userOne).stake([tokenIds[1]]);

    // Verify no double initial unlock
    const vestingState = await bcgVesting.vestingState(tokenIds[1]);
    expect(vestingState[1]).to.be.true; // initialUnlockCollected should be true
  });

  it("Should properly handle vesting pool depletion", async function () {
    const { userOne, beramonium, erc20, gemhunters, bcgVesting } = await loadFixture(
      deployFullSystemFixture
    );

    // Stake a token
    const tokenId = 125;
    await beramonium.connect(userOne).approve(gemhunters, tokenId);
    await gemhunters.connect(userOne).stake([tokenId]);

    // Time travel to end of vesting period
    const VESTING_PERIOD_IN_DAYS = await bcgVesting.VESTING_PERIOD_IN_DAYS();
    await time.increase(Number(VESTING_PERIOD_IN_DAYS) * 24 * 60 * 60);

    // Try to collect rewards
    await bcgVesting.connect(userOne).collectPendingRewards(tokenId);

    // Try to collect again - should yield no rewards
    const balanceBefore = await erc20.balanceOf(userOne.address);
    await bcgVesting.connect(userOne).collectPendingRewards(tokenId);
    const balanceAfter = await erc20.balanceOf(userOne.address);
    expect(balanceAfter).to.equal(balanceBefore);
  });

  it("Should handle listener revert scenarios correctly", async function () {
    const { deployer, userOne, beramonium, gemhunters, bcgVesting } = await loadFixture(
      deployFullSystemFixture
    );

    // Deploy a malicious/failing listener
    const MockFailingListener = await ethers.getContractFactory("MockFailingListener");
    const failingListener = await MockFailingListener.deploy();

    // Add failing listener with allowFail = true
    const listenerParams = {
      addr: await failingListener.getAddress(),
      onStakedSelector: failingListener.interface.getFunction("onTokenStaked").selector,
      onUnstakedSelector:
        failingListener.interface.getFunction("onTokenUnstaked").selector,
      allowFail: true,
    };
    await gemhunters.connect(deployer).pushListener(listenerParams);

    // Should still work with failing listener when allowFail = true
    const tokenId = 125;
    await beramonium.connect(userOne).approve(gemhunters, tokenId);
    await expect(gemhunters.connect(userOne).stake([tokenId])).to.not.be.reverted;

    // Add another failing listener with allowFail = false
    const listenerParams2 = { ...listenerParams, allowFail: false };
    await gemhunters.connect(deployer).pushListener(listenerParams2);

    // Should revert when allowFail = false
    const tokenId2 = 126;
    await beramonium.connect(userOne).approve(gemhunters, tokenId2);
    await expect(gemhunters.connect(userOne).stake([tokenId2])).to.be.reverted;
  });
});
