// We require the Hardhat Runtime Environment explicitly here. This is optional
// but useful for running the script in a standalone fashion through `node <script>`.
//
// You can also run a script with `npx hardhat run <script>`. If you do that, Hardhat
// will compile your contracts, add the Hardhat Runtime Environment's members to the
// global scope, and execute the script.
import hre, { ethers, upgrades } from "hardhat";

const networks = {
  homestead: ethers.getDefaultProvider("homestead").getNetwork(),
  sepolia: ethers.getDefaultProvider("sepolia").getNetwork(),
};

const chainIds = {
  homestead: 1,
  sepolia: 11155111,
  bartio: 80084,
};

// This script deploys our test contracts: Beramonium NFT, Gemhunters (NFT staking),
// BeramoniumToken and finally the BcgVesting contract.
//
// Since the BcgVesting contract is integrated with the Gemhunters contract via
// callbacks, we also setup the on-chain listeners for the Gemhunters contract.
//
// Finally, we fuel the vesting contract with the ERC-20 tokens of VESTING_POOL_TOTAL.
async function main() {
  const chainId = Number(await hre.network.provider.request({ method: "eth_chainId" }));
  const [owner] = await ethers.getSigners();

  const verifySourceCode = Object.values(chainIds).includes(chainId);

  // 1. Deploy ERC-20 token
  const ERC20 = await hre.ethers.getContractFactory("BeramoniumToken");
  const erc20 = await ERC20.deploy();
  await erc20.waitForDeployment();
  console.log(`ERC-20 deployed to ${await erc20.getAddress()}`);

  // 1.5 Deploy the dummy Beramonium token for now
  const maxPerWalletPublic = 1000;
  const collectionSize = 6000;
  const price = hre.ethers.parseEther(chainId == chainIds.homestead ? "0.045" : "0.001");
  const startTime = 1678208400;
  const premintWallet = owner;
  const premintAmount = 1;
  const baseTokenURI = "https://api.beramonium.io/api/v1/genesis/";

  const Beramonium = await hre.ethers.getContractFactory("Beramonium");
  let beramoniumDepl =
    chainId == chainIds.sepolia
      ? Beramonium.attach("0x8CCd0654D388A267165718F979ee2Fc62F13752F")
      : await Beramonium.deploy(
          maxPerWalletPublic,
          collectionSize,
          price,
          startTime,
          premintWallet,
          premintAmount,
          baseTokenURI
        );
  const beramonium = await beramoniumDepl.waitForDeployment();

  // 2. Deploy dummy Gemhunters contract for now
  const Gemhunters = await hre.ethers.getContractFactory("BeramoniumGemhuntersListeners");
  const gemhunters = await upgrades.deployProxy(
    Gemhunters,
    [await beramonium.getAddress()],
    {
      kind: "uups",
      verifySourceCode,
    }
  );
  await gemhunters.waitForDeployment();
  console.log(`Gemhunters deployed to ${await gemhunters.getAddress()}`);

  // 3. Deploy the vesting contract
  const BcgVesting = await hre.ethers.getContractFactory("BcgVesting");
  const bcgVesting = await BcgVesting.deploy(
    await erc20.getAddress(),
    await gemhunters.getAddress()
  );
  await bcgVesting.waitForDeployment();
  console.log(`BcgVesting deployed to ${await bcgVesting.getAddress()}`);

  // 4. Setup the staking listeners
  const listenerParams = {
    addr: await bcgVesting.getAddress(),
    onStakedSelector: await bcgVesting.interface.getFunction("onTokenStaked").selector,
    onUnstakedSelector: await bcgVesting.interface.getFunction("onTokenUnstaked")
      .selector,
    allowFail: false,
  };

  const pushListenerTx = await gemhunters.pushListener(listenerParams);
  await pushListenerTx.wait();
  console.log(`Staking listener added`);

  // 4. Set up the vesting contract
  const approveTx = await erc20.approve(
    bcgVesting,
    await bcgVesting.VESTING_POOL_TOTAL()
  );
  await approveTx.wait();
  console.log("Approved");
  const initPoolTx = await bcgVesting.initializeVestingPool();
  await initPoolTx.wait();
  console.log(`Vesting pool initialized`);

  if (verifySourceCode) {
    await new Promise((resolve) => setTimeout(resolve, 5000));

    // Verify BERAMO
    await hre.run("verify:verify", {
      address: await erc20.getAddress(),
      constructorArguments: [],
    });
    console.log("BERAMO verified at", await erc20.getAddress());

    // Verify Beramonium
    await hre.run("verify:verify", {
      address: await beramonium.getAddress(),
      constructorArguments: [
        maxPerWalletPublic,
        collectionSize,
        price,
        startTime,
        premintWallet.address,
        premintAmount,
        baseTokenURI,
      ],
    });
    console.log("Beramonium verified at", await beramonium.getAddress());

    // Verify Gemhunters
    const implAddress = await upgrades.erc1967.getImplementationAddress(
      await gemhunters.getAddress()
    );
    await hre.run("verify:verify", {
      address: implAddress,
      constructorArguments: [],
    });
    console.log(`Implementation contract verified at ${implAddress}`);

    await hre.run("verify:verify", {
      address: await gemhunters.getAddress(),
      constructorArguments: [],
    });
    console.log(`Gemhunters verified at ${await gemhunters.getAddress()}`);

    // Verify BcgVesting
    await hre.run("verify:verify", {
      address: await bcgVesting.getAddress(),
      constructorArguments: [await erc20.getAddress(), await gemhunters.getAddress()],
    });
    console.log(`BcgVesting verified at ${await bcgVesting.getAddress()}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
