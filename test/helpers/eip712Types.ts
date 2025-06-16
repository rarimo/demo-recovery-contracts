import { TypedDataField } from "ethers";

export const VaultTypes: Record<string, TypedDataField[]> = {
  EmergencyWithdraw: [
    { name: "to", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "nonce", type: "uint256" },
  ],
};
