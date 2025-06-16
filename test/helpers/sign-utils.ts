import { VaultTypes } from "@/test/helpers/eip712Types";
import { EIP712Upgradeable, Vault } from "@ethers-v6";

import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

import { TypedDataDomain } from "ethers";

export interface EmergencyWithdrawData {
  to: string;
  amount: bigint;
  nonce: bigint;
}

export async function getDomain(contract: EIP712Upgradeable): Promise<TypedDataDomain> {
  const { fields, name, version, chainId, verifyingContract, salt, extensions } = await contract.eip712Domain();

  if (extensions.length > 0) {
    throw Error("Extensions not implemented");
  }

  const domain: TypedDataDomain = {
    name,
    version,
    chainId,
    verifyingContract,
    salt,
  };

  const domainFieldNames: Array<string> = ["name", "version", "chainId", "verifyingContract", "salt"];

  for (const [i, name] of domainFieldNames.entries()) {
    if (!((fields as any) & (1 << i))) {
      delete (domain as any)[name];
    }
  }

  return domain;
}

export async function getEmergencyWithdrawSignature(
  vault: Vault,
  account: SignerWithAddress,
  data: EmergencyWithdrawData,
): Promise<string> {
  const domain = await getDomain(vault as unknown as EIP712Upgradeable);

  return await account.signTypedData(domain, VaultTypes, {
    to: data.to,
    amount: data.amount,
    nonce: data.nonce,
  });
}
