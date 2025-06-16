import { getConfig } from "@/deploy/config/config";
import { VaultFactory__factory, Vault__factory } from "@ethers-v6";

import { Deployer, Reporter } from "@solarity/hardhat-migrate";

export = async (deployer: Deployer) => {
  const config = (await getConfig())!;

  const vaultImplementation = await deployer.deploy(Vault__factory);
  const vaultFactory = await deployer.deployERC1967Proxy(VaultFactory__factory);

  await vaultFactory.__VaultFactory_init(await vaultImplementation.getAddress(), config.factoryOwner);

  await Reporter.reportContractsMD(
    ["Vault Implementation", await vaultImplementation.getAddress()],
    ["VaultFactory", await vaultFactory.getAddress()],
  );
};
