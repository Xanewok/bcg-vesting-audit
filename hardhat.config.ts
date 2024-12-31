require("dotenv").config();

import { HardhatUserConfig, task } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "@nomicfoundation/hardhat-ledger";
import "@openzeppelin/hardhat-upgrades";

function isNonEmptyString(value: any): value is string {
  return typeof value === "string" && value !== "";
}

// This is a sample Hardhat task. To learn how to create your own go to
// https://hardhat.org/guides/create-task.html
task("accounts", "Prints the list of accounts", async (taskArgs, hre) => {
  const accounts = await hre.ethers.getSigners();

  for (const account of accounts) {
    console.log(account.address);
  }
});

// You need to export an object to set up your config
// Go to https://hardhat.org/config/ to learn more
const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.27",
    settings: {
      optimizer: {
        enabled: true,
        runs: 10000,
      },
    },
  },
  paths: {
    sources: "./src",
  },
  networks: {
    // https://hardhat.org/hardhat-network/docs/metamask-issue
    hardhat: {
      chainId: 1337,
    },
    mainnet: {
      url: process.env.MAINNET_URL || "",
      ledgerAccounts: [process.env.LEDGER_ACCOUNT].filter(isNonEmptyString),
    },
    sepolia: {
      url: process.env.SEPOLIA_URL || "",
      ledgerAccounts: [process.env.LEDGER_ACCOUNT].filter(isNonEmptyString),
    },
    bartio: {
      chainId: 80084,
      url: "https://bartio.rpc.berachain.com",
      ledgerAccounts: [process.env.LEDGER_ACCOUNT].filter(isNonEmptyString),
    },
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS !== undefined,
    currency: "USD",
  },
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY,
    customChains: [
      {
        network: "bartio",
        chainId: 80084,
        urls: {
          apiURL: "https://api.routescan.io/v2/network/testnet/evm/80084/etherscan/api",
          browserURL: "https://bartio.beratrail.io",
        },
      },
    ],
  },
};

export default config;
