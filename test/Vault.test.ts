import { Vault, VaultFactory } from "@ethers-v6";

import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

import { expect } from "chai";
import { ethers } from "hardhat";

import { EmergencyWithdrawData, Reverter, getEmergencyWithdrawSignature } from "./helpers";

describe("Vault", () => {
  // import {ErrorFragment} from "ethers";
  // it.only("look for error", async () => {
  //     //
  //     const contractInterface = vault.interface;
  //
  //     for (const fragment of contractInterface.fragments) {
  //       if (fragment.type === "error") {
  //         try {
  //           console.log(contractInterface.decodeErrorResult(fragment as ErrorFragment, "0xa2708c6f"));
  //           console.log(fragment);
  //         } catch {}
  //       }
  //     }
  //   });

  const reverter = new Reverter();

  let OWNER: SignerWithAddress;
  let RECOVERY_KEY: SignerWithAddress;
  let NEW_OWNER: SignerWithAddress;
  let ATTACKER: SignerWithAddress;
  let USER1: SignerWithAddress;
  let USER2: SignerWithAddress;

  let vault: Vault;
  let vaultFactory: VaultFactory;
  let vaultImplementation: Vault;
  let factoryImplementation: VaultFactory;

  const DEFAULT_TIMELOCK = time.duration.days(7); // 7 days using helper
  const CUSTOM_TIMELOCK = time.duration.days(3); // 3 days using helper

  before(async () => {
    [OWNER, RECOVERY_KEY, NEW_OWNER, ATTACKER, USER1, USER2] = await ethers.getSigners();

    // Deploy implementations
    vaultImplementation = await ethers.deployContract("Vault");
    factoryImplementation = await ethers.deployContract("VaultFactory");

    // Deploy factory proxy
    const factoryProxy = await ethers.deployContract("ERC1967Proxy", [await factoryImplementation.getAddress(), "0x"]);
    vaultFactory = await ethers.getContractAt("VaultFactory", await factoryProxy.getAddress());

    // Initialize factory
    await vaultFactory.__VaultFactory_init(await vaultImplementation.getAddress(), OWNER.address);

    // Deploy vault through factory
    const tx = await vaultFactory.connect(OWNER).deployVault(RECOVERY_KEY.address, DEFAULT_TIMELOCK);
    const receipt = await tx.wait();
    const vaultAddress = receipt?.logs[0]?.address;
    vault = await ethers.getContractAt("Vault", vaultAddress!);

    await reverter.snapshot();
  });

  afterEach(reverter.revert);

  describe("Vault Initialization", () => {
    it("should initialize vault with correct parameters", async () => {
      expect(await vault.owner()).to.equal(OWNER.address);
      expect(await vault.recoveryKey()).to.equal(RECOVERY_KEY.address);
      expect(await vault.timelock()).to.equal(DEFAULT_TIMELOCK);
      expect(await vault.getBalance()).to.equal(0);

      const recoveryRequest = await vault.getRecoveryRequest();
      expect(recoveryRequest.isActive).to.be.true;
      expect(recoveryRequest.newOwner).to.equal(OWNER.address);
      expect(recoveryRequest.executeAfter).to.be.greaterThan(0);
    });

    it("should revert if initialized with zero recovery key", async () => {
      const tx = vaultFactory.connect(USER1).deployVault(ethers.ZeroAddress, DEFAULT_TIMELOCK);
      await expect(tx).to.be.revertedWithCustomError(vault, "InvalidRecoveryKeyInit");
    });

    it("should revert if initialized with zero timelock", async () => {
      const tx = vaultFactory.connect(USER1).deployVault(RECOVERY_KEY.address, 0);
      await expect(tx).to.be.revertedWithCustomError(vault, "InvalidTimelockInit");
    });

    it("should not allow double initialization", async () => {
      await expect(
        vault.__Vault_init(OWNER.address, RECOVERY_KEY.address, DEFAULT_TIMELOCK, vaultFactory.target),
      ).to.be.revertedWithCustomError(vault, "InvalidInitialization");
    });
  });

  describe("ETH Deposits", () => {
    it("should accept ETH via receive function", async () => {
      const depositAmount = ethers.parseEther("1.0");

      await expect(OWNER.sendTransaction({ to: await vault.getAddress(), value: depositAmount }))
        .to.emit(vault, "Deposit")
        .withArgs(OWNER.address, depositAmount);

      expect(await vault.getBalance()).to.equal(depositAmount);
      expect(await ethers.provider.getBalance(await vault.getAddress())).to.equal(depositAmount);
    });

    it("should accept ETH via fallback function", async () => {
      const depositAmount = ethers.parseEther("0.5");

      await expect(
        OWNER.sendTransaction({
          to: await vault.getAddress(),
          value: depositAmount,
          data: "0x1234",
        }),
      )
        .to.emit(vault, "Deposit")
        .withArgs(OWNER.address, depositAmount);

      expect(await vault.getBalance()).to.equal(depositAmount);
    });

    it("should accept ETH via deposit function", async () => {
      const depositAmount = ethers.parseEther("2.0");

      await expect(vault.connect(USER1).deposit({ value: depositAmount }))
        .to.emit(vault, "Deposit")
        .withArgs(USER1.address, depositAmount);

      expect(await vault.getBalance()).to.equal(depositAmount);
    });

    it("should revert on deposit with zero value", async () => {
      await expect(vault.connect(USER1).deposit({ value: 0 })).to.be.revertedWithCustomError(vault, "InvalidAmount");
    });

    it("should handle multiple deposits", async () => {
      const amount1 = ethers.parseEther("1.0");
      const amount2 = ethers.parseEther("2.0");

      await vault.connect(USER1).deposit({ value: amount1 });
      await vault.connect(USER2).deposit({ value: amount2 });

      expect(await vault.getBalance()).to.equal(amount1 + amount2);
    });
  });

  describe("ETH Withdrawals", () => {
    beforeEach(async () => {
      // Fund the vault
      await vault.deposit({ value: ethers.parseEther("5.0") });
    });

    describe("withdraw", () => {
      it("should allow owner to withdraw ETH", async () => {
        const withdrawAmount = ethers.parseEther("1.0");
        const initialBalance = await ethers.provider.getBalance(USER1.address);

        await expect(vault.connect(OWNER).withdraw(USER1.address, withdrawAmount))
          .to.emit(vault, "Withdrawal")
          .withArgs(USER1.address, withdrawAmount);

        expect(await vault.getBalance()).to.equal(ethers.parseEther("4.0"));
        expect(await ethers.provider.getBalance(USER1.address)).to.equal(initialBalance + withdrawAmount);
      });

      it("should revert if non-owner tries to withdraw", async () => {
        await expect(
          vault.connect(USER1).withdraw(USER1.address, ethers.parseEther("1.0")),
        ).to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
      });

      it("should revert on withdrawal with zero amount", async () => {
        await expect(vault.connect(OWNER).withdraw(USER1.address, 0)).to.be.revertedWithCustomError(
          vault,
          "InvalidAmount",
        );
      });

      it("should revert on withdrawal exceeding balance", async () => {
        const excessiveAmount = ethers.parseEther("10.0");
        await expect(vault.connect(OWNER).withdraw(USER1.address, excessiveAmount)).to.be.revertedWithCustomError(
          vault,
          "InsufficientBalance",
        );
      });
    });

    describe("withdrawAll", () => {
      it("should allow owner to withdraw all ETH", async () => {
        const vaultBalance = await vault.getBalance();
        const initialUserBalance = await ethers.provider.getBalance(USER1.address);

        await expect(vault.connect(OWNER).withdrawAll(USER1.address))
          .to.emit(vault, "Withdrawal")
          .withArgs(USER1.address, vaultBalance);

        expect(await vault.getBalance()).to.equal(0);
        expect(await ethers.provider.getBalance(USER1.address)).to.equal(initialUserBalance + vaultBalance);
      });

      it("should revert if vault has zero balance", async () => {
        // First withdraw all
        await vault.connect(OWNER).withdrawAll(USER1.address);

        await expect(vault.connect(OWNER).withdrawAll(USER1.address)).to.be.revertedWithCustomError(
          vault,
          "InvalidAmount",
        );
      });

      it("should revert if non-owner tries to withdraw all", async () => {
        await expect(vault.connect(USER1).withdrawAll(USER1.address)).to.be.revertedWithCustomError(
          vault,
          "OwnableUnauthorizedAccount",
        );
      });
    });
  });

  describe("Recovery Mechanism", () => {
    describe("setRecoveryKey", () => {
      it("should allow owner to set recovery key", async () => {
        await expect(vault.connect(OWNER).setRecoveryKey(NEW_OWNER.address))
          .to.emit(vault, "RecoveryKeySet")
          .withArgs(RECOVERY_KEY.address, NEW_OWNER.address);

        expect(await vault.recoveryKey()).to.equal(NEW_OWNER.address);
      });

      it("should revert if non-owner tries to set recovery key", async () => {
        await expect(vault.connect(USER1).setRecoveryKey(NEW_OWNER.address)).to.be.revertedWithCustomError(
          vault,
          "OwnableUnauthorizedAccount",
        );
      });

      it("should revert if setting zero address as recovery key", async () => {
        await expect(vault.connect(OWNER).setRecoveryKey(ethers.ZeroAddress)).to.be.revertedWithCustomError(
          vault,
          "InvalidRecoveryKey",
        );
      });
    });

    describe("setTimelock", () => {
      it("should allow owner to set timelock", async () => {
        await expect(vault.connect(OWNER).setTimelock(CUSTOM_TIMELOCK))
          .to.emit(vault, "TimelockUpdated")
          .withArgs(DEFAULT_TIMELOCK, CUSTOM_TIMELOCK);

        expect(await vault.timelock()).to.equal(CUSTOM_TIMELOCK);
      });

      it("should revert if non-owner tries to set timelock", async () => {
        await expect(vault.connect(USER1).setTimelock(CUSTOM_TIMELOCK)).to.be.revertedWithCustomError(
          vault,
          "OwnableUnauthorizedAccount",
        );
      });

      it("should revert if setting zero timelock", async () => {
        await expect(vault.connect(OWNER).setTimelock(0)).to.be.revertedWithCustomError(vault, "InvalidTimelock");
      });
    });

    describe("initiateRecovery", () => {
      beforeEach(async () => {
        // Cancel the initial recovery request created during initialization
        await vault.connect(OWNER).cancelRecovery();
      });

      it("should allow recovery key to initiate recovery", async () => {
        const currentTime = await time.latest();
        const executeAfter = currentTime + DEFAULT_TIMELOCK;

        await expect(vault.connect(RECOVERY_KEY).initiateRecovery(NEW_OWNER.address)).to.emit(
          vault,
          "RecoveryInitiated",
        );

        const recoveryRequest = await vault.getRecoveryRequest();
        expect(recoveryRequest.isActive).to.be.true;
        expect(recoveryRequest.newOwner).to.equal(NEW_OWNER.address);
        expect(recoveryRequest.executeAfter).to.be.closeTo(executeAfter, 5);
      });

      it("should revert if non-recovery-key tries to initiate recovery", async () => {
        await expect(vault.connect(ATTACKER).initiateRecovery(ATTACKER.address)).to.be.revertedWithCustomError(
          vault,
          "UnauthorizedRecoveryAction",
        );
      });

      it("should revert if recovery is already active", async () => {
        await vault.connect(RECOVERY_KEY).initiateRecovery(NEW_OWNER.address);

        await expect(vault.connect(RECOVERY_KEY).initiateRecovery(USER1.address)).to.be.revertedWithCustomError(
          vault,
          "RecoveryAlreadyActive",
        );
      });
    });

    describe("executeRecovery", () => {
      beforeEach(async () => {
        // Cancel the initial recovery request and create a new one
        await vault.connect(OWNER).cancelRecovery();
        await vault.connect(RECOVERY_KEY).initiateRecovery(NEW_OWNER.address);
      });

      it("should allow anyone to execute recovery after timelock", async () => {
        // Advance time past the timelock
        await time.increase(DEFAULT_TIMELOCK + 1);

        await expect(vault.connect(USER1).executeRecovery())
          .to.emit(vault, "RecoveryExecuted")
          .withArgs(USER1.address, NEW_OWNER.address);

        expect(await vault.owner()).to.equal(NEW_OWNER.address);

        const recoveryRequest = await vault.getRecoveryRequest();
        expect(recoveryRequest.isActive).to.be.false;
      });

      it("should allow recovery key to execute recovery after timelock", async () => {
        // Advance time past the timelock
        await time.increase(DEFAULT_TIMELOCK + 1);

        await expect(vault.connect(RECOVERY_KEY).executeRecovery())
          .to.emit(vault, "RecoveryExecuted")
          .withArgs(RECOVERY_KEY.address, NEW_OWNER.address);

        expect(await vault.owner()).to.equal(NEW_OWNER.address);

        const recoveryRequest = await vault.getRecoveryRequest();
        expect(recoveryRequest.isActive).to.be.false;
      });

      it("should revert if trying to execute before timelock", async () => {
        await expect(vault.connect(USER1).executeRecovery()).to.be.revertedWithCustomError(
          vault,
          "RecoveryStillLocked",
        );
      });

      it("should revert if no active recovery", async () => {
        await vault.connect(OWNER).cancelRecovery();

        await time.increase(DEFAULT_TIMELOCK + 1);

        await expect(vault.connect(USER1).executeRecovery()).to.be.revertedWithCustomError(vault, "NoActiveRecovery");
      });
    });

    describe("cancelRecovery", () => {
      beforeEach(async () => {
        // Cancel the initial recovery request and create a new one
        await vault.connect(OWNER).cancelRecovery();
        await vault.connect(RECOVERY_KEY).initiateRecovery(NEW_OWNER.address);
      });

      it("should allow owner to cancel recovery", async () => {
        await expect(vault.connect(OWNER).cancelRecovery()).to.emit(vault, "RecoveryCanceled").withArgs(OWNER.address);

        const recoveryRequest = await vault.getRecoveryRequest();
        expect(recoveryRequest.isActive).to.be.false;
      });

      it("should allow recovery key to cancel recovery", async () => {
        await expect(vault.connect(RECOVERY_KEY).cancelRecovery())
          .to.emit(vault, "RecoveryCanceled")
          .withArgs(RECOVERY_KEY.address);

        const recoveryRequest = await vault.getRecoveryRequest();
        expect(recoveryRequest.isActive).to.be.false;
      });

      it("should revert if unauthorized user tries to cancel", async () => {
        await expect(vault.connect(ATTACKER).cancelRecovery()).to.be.revertedWithCustomError(
          vault,
          "UnauthorizedRecoveryAction",
        );
      });

      it("should revert if no active recovery", async () => {
        await vault.connect(OWNER).cancelRecovery();

        await expect(vault.connect(OWNER).cancelRecovery()).to.be.revertedWithCustomError(vault, "NoActiveRecovery");
      });
    });
  });

  describe("Emergency Withdrawal", () => {
    beforeEach(async () => {
      // Fund the vault
      await vault.deposit({ value: ethers.parseEther("3.0") });
      // Cancel initial recovery and initiate a new recovery
      await vault.connect(OWNER).cancelRecovery();
      await vault.connect(RECOVERY_KEY).initiateRecovery(NEW_OWNER.address);
      // Advance time to make recovery executable
      await time.increase(DEFAULT_TIMELOCK + 1);
    });

    it("should allow emergency withdraw with valid signature when recovery is executable", async () => {
      const withdrawAmount = ethers.parseEther("1.0");
      const initialBalance = await ethers.provider.getBalance(USER1.address);
      const nonce = await vault.getRecoveryKeyNonce();

      const withdrawData: EmergencyWithdrawData = {
        to: USER1.address,
        amount: withdrawAmount,
        nonce: nonce,
      };

      const signature = await getEmergencyWithdrawSignature(vault, RECOVERY_KEY, withdrawData);

      await expect(vault.emergencyWithdraw(USER1.address, withdrawAmount, signature))
        .to.emit(vault, "EmergencyWithdrawal")
        .withArgs(USER1.address, withdrawAmount);

      expect(await vault.getBalance()).to.equal(ethers.parseEther("2.0"));
      expect(await ethers.provider.getBalance(USER1.address)).to.equal(initialBalance + withdrawAmount);
    });

    it("should increment nonce after successful emergency withdrawal", async () => {
      const withdrawAmount = ethers.parseEther("1.0");
      const initialNonce = await vault.getRecoveryKeyNonce();

      const withdrawData: EmergencyWithdrawData = {
        to: USER1.address,
        amount: withdrawAmount,
        nonce: initialNonce,
      };

      const signature = await getEmergencyWithdrawSignature(vault, RECOVERY_KEY, withdrawData);

      await vault.emergencyWithdraw(USER1.address, withdrawAmount, signature);

      const finalNonce = await vault.getRecoveryKeyNonce();
      expect(finalNonce).to.equal(initialNonce + 1n);
    });

    it("should revert if recovery is not executable", async () => {
      // Cancel recovery to make it not executable
      await vault.connect(OWNER).cancelRecovery();

      const withdrawAmount = ethers.parseEther("1.0");
      const nonce = await vault.getRecoveryKeyNonce();

      const withdrawData: EmergencyWithdrawData = {
        to: USER1.address,
        amount: withdrawAmount,
        nonce: nonce,
      };

      const signature = await getEmergencyWithdrawSignature(vault, RECOVERY_KEY, withdrawData);

      await expect(vault.emergencyWithdraw(USER1.address, withdrawAmount, signature)).to.be.revertedWithCustomError(
        vault,
        "EmergencyWithdrawalNotAvailable",
      );
    });

    it("should revert with invalid signature", async () => {
      const withdrawAmount = ethers.parseEther("1.0");
      const nonce = await vault.getRecoveryKeyNonce();

      const withdrawData: EmergencyWithdrawData = {
        to: USER1.address,
        amount: withdrawAmount,
        nonce: nonce,
      };

      // Sign with wrong signer (ATTACKER instead of RECOVERY_KEY)
      const invalidSignature = await getEmergencyWithdrawSignature(vault, ATTACKER, withdrawData);

      await expect(
        vault.emergencyWithdraw(USER1.address, withdrawAmount, invalidSignature),
      ).to.be.revertedWithCustomError(vault, "OnlyRecoveryKeyCanEmergencyWithdraw");
    });

    it("should revert with wrong nonce", async () => {
      const withdrawAmount = ethers.parseEther("1.0");
      const currentNonce = await vault.getRecoveryKeyNonce();

      const withdrawData: EmergencyWithdrawData = {
        to: USER1.address,
        amount: withdrawAmount,
        nonce: currentNonce + 1n, // Wrong nonce
      };

      const signature = await getEmergencyWithdrawSignature(vault, RECOVERY_KEY, withdrawData);

      await expect(vault.emergencyWithdraw(USER1.address, withdrawAmount, signature)).to.be.revertedWithCustomError(
        vault,
        "OnlyRecoveryKeyCanEmergencyWithdraw",
      );
    });

    it("should revert with reused signature", async () => {
      const withdrawAmount = ethers.parseEther("1.0");
      const nonce = await vault.getRecoveryKeyNonce();

      const withdrawData: EmergencyWithdrawData = {
        to: USER1.address,
        amount: withdrawAmount,
        nonce: nonce,
      };

      const signature = await getEmergencyWithdrawSignature(vault, RECOVERY_KEY, withdrawData);

      // First withdrawal should succeed
      await vault.emergencyWithdraw(USER1.address, withdrawAmount, signature);

      await vault.connect(RECOVERY_KEY).initiateRecovery(NEW_OWNER.address);
      await time.increase(DEFAULT_TIMELOCK + 1);

      // Second withdrawal with same signature should fail
      await expect(vault.emergencyWithdraw(USER1.address, withdrawAmount, signature)).to.be.revertedWithCustomError(
        vault,
        "OnlyRecoveryKeyCanEmergencyWithdraw",
      );
    });

    it("should revert on emergency withdrawal with zero amount", async () => {
      const nonce = await vault.getRecoveryKeyNonce();

      const withdrawData: EmergencyWithdrawData = {
        to: USER1.address,
        amount: 0n,
        nonce: nonce,
      };

      const signature = await getEmergencyWithdrawSignature(vault, RECOVERY_KEY, withdrawData);

      await expect(vault.emergencyWithdraw(USER1.address, 0, signature)).to.be.revertedWithCustomError(
        vault,
        "InvalidAmount",
      );
    });

    it("should revert on emergency withdrawal exceeding balance", async () => {
      const excessiveAmount = ethers.parseEther("10.0");
      const nonce = await vault.getRecoveryKeyNonce();

      const withdrawData: EmergencyWithdrawData = {
        to: USER1.address,
        amount: excessiveAmount,
        nonce: nonce,
      };

      const signature = await getEmergencyWithdrawSignature(vault, RECOVERY_KEY, withdrawData);

      await expect(vault.emergencyWithdraw(USER1.address, excessiveAmount, signature)).to.be.revertedWithCustomError(
        vault,
        "InsufficientBalance",
      );
    });

    it("should allow different recipients with proper signatures", async () => {
      const withdrawAmount = ethers.parseEther("1.0");
      const nonce1 = await vault.getRecoveryKeyNonce();

      // First withdrawal to USER1
      const withdrawData1: EmergencyWithdrawData = {
        to: USER1.address,
        amount: withdrawAmount,
        nonce: nonce1,
      };

      const signature1 = await getEmergencyWithdrawSignature(vault, RECOVERY_KEY, withdrawData1);

      await vault.emergencyWithdraw(USER1.address, withdrawAmount, signature1);

      await vault.connect(RECOVERY_KEY).initiateRecovery(NEW_OWNER.address);
      await time.increase(DEFAULT_TIMELOCK + 1);

      // Second withdrawal to USER2 (with incremented nonce)
      const nonce2 = await vault.getRecoveryKeyNonce();
      const withdrawData2: EmergencyWithdrawData = {
        to: USER2.address,
        amount: withdrawAmount,
        nonce: nonce2,
      };

      const signature2 = await getEmergencyWithdrawSignature(vault, RECOVERY_KEY, withdrawData2);

      await expect(vault.emergencyWithdraw(USER2.address, withdrawAmount, signature2))
        .to.emit(vault, "EmergencyWithdrawal")
        .withArgs(USER2.address, withdrawAmount);

      expect(await vault.getBalance()).to.equal(ethers.parseEther("1.0"));
    });
  });

  describe("View Functions", () => {
    beforeEach(async () => {
      await vault.deposit({ value: ethers.parseEther("2.0") });
    });

    it("should return correct balance", async () => {
      expect(await vault.getBalance()).to.equal(ethers.parseEther("2.0"));
    });

    it("should check sufficient balance correctly", async () => {
      expect(await vault.hasSufficientBalance(ethers.parseEther("1.0"))).to.be.true;
      expect(await vault.hasSufficientBalance(ethers.parseEther("2.0"))).to.be.true;
      expect(await vault.hasSufficientBalance(ethers.parseEther("3.0"))).to.be.false;
    });

    it("should return correct recovery state", async () => {
      expect(await vault.canExecuteRecovery()).to.be.false;
      expect(await vault.getTimeUntilRecovery()).to.be.greaterThan(0); // Initial recovery exists

      // Cancel initial recovery and create a new one
      await vault.connect(OWNER).cancelRecovery();
      expect(await vault.canExecuteRecovery()).to.be.false;
      expect(await vault.getTimeUntilRecovery()).to.equal(0);

      await vault.connect(RECOVERY_KEY).initiateRecovery(NEW_OWNER.address);

      expect(await vault.canExecuteRecovery()).to.be.false;
      expect(await vault.getTimeUntilRecovery()).to.be.greaterThan(0);

      await time.increase(DEFAULT_TIMELOCK + 1);

      expect(await vault.canExecuteRecovery()).to.be.true;
      expect(await vault.getTimeUntilRecovery()).to.equal(0);
    });

    it("should return correct recovery key nonce", async () => {
      const initialNonce = await vault.getRecoveryKeyNonce();
      expect(initialNonce).to.equal(0);

      // Fund vault and set up emergency withdrawal conditions
      await vault.deposit({ value: ethers.parseEther("2.0") });
      await vault.connect(OWNER).cancelRecovery();
      await vault.connect(RECOVERY_KEY).initiateRecovery(NEW_OWNER.address);
      await time.increase(DEFAULT_TIMELOCK + 1);

      // Perform emergency withdrawal to increment nonce
      const withdrawAmount = ethers.parseEther("1.0");
      const withdrawData: EmergencyWithdrawData = {
        to: USER1.address,
        amount: withdrawAmount,
        nonce: initialNonce,
      };

      const signature = await getEmergencyWithdrawSignature(vault, RECOVERY_KEY, withdrawData);
      await vault.emergencyWithdraw(USER1.address, withdrawAmount, signature);

      const finalNonce = await vault.getRecoveryKeyNonce();
      expect(finalNonce).to.equal(1);
    });
  });

  describe("VaultFactory", () => {
    describe("Initialization", () => {
      it("should initialize factory with correct parameters", async () => {
        expect(await vaultFactory.owner()).to.equal(OWNER.address);
        expect(await vaultFactory.vaultImplementation()).to.equal(await vaultImplementation.getAddress());
      });

      it("should not allow double initialization", async () => {
        await expect(
          vaultFactory.__VaultFactory_init(await vaultImplementation.getAddress(), OWNER.address),
        ).to.be.revertedWithCustomError(vaultFactory, "InvalidInitialization");
      });
    });

    describe("Vault Deployment", () => {
      it("should deploy vault with correct parameters", async () => {
        const tx = await vaultFactory.connect(USER1).deployVault(USER2.address, CUSTOM_TIMELOCK);
        const receipt = await tx.wait();

        await expect(tx).to.emit(vaultFactory, "VaultDeployed");

        // Get deployed vault address
        const vaultAddress = receipt?.logs[0]?.address;
        const deployedVault = await ethers.getContractAt("Vault", vaultAddress!);

        expect(await deployedVault.owner()).to.equal(USER1.address);
        expect(await deployedVault.recoveryKey()).to.equal(USER2.address);
        expect(await deployedVault.timelock()).to.equal(CUSTOM_TIMELOCK);
        expect(await deployedVault.factory()).to.equal(await vaultFactory.getAddress());

        const vaultsByOwner = await vaultFactory.getVaultsByOwner(USER1.address);
        expect(vaultsByOwner).to.have.lengthOf(1);
        expect(vaultsByOwner[0]).to.equal(vaultAddress);
        expect(await vaultFactory.vaultToOwner(vaultAddress!)).to.equal(USER1.address);

        // Test recovery key enumeration
        const vaultsByRecoveryKey = await vaultFactory.getVaultsByRecoveryKey(USER2.address);
        expect(vaultsByRecoveryKey).to.have.lengthOf(1);
        expect(vaultsByRecoveryKey[0]).to.equal(vaultAddress);
      });

      it("should allow owner to deploy multiple vaults", async () => {
        await vaultFactory.connect(USER1).deployVault(USER2.address, CUSTOM_TIMELOCK);
        
        await expect(vaultFactory.connect(USER1).deployVault(USER2.address, CUSTOM_TIMELOCK))
          .to.emit(vaultFactory, "VaultDeployed");

        expect(await vaultFactory.getVaultCountByOwner(USER1.address)).to.equal(2);
        expect(await vaultFactory.hasVaults(USER1.address)).to.be.true;
      });

      it("should predict vault addresses correctly", async () => {
        const salt = ethers.keccak256(ethers.solidityPacked(
          ["address", "uint256"], 
          [USER1.address, 0]
        ));
        
        const predictedAddress = await vaultFactory.predictVaultAddress(
          await vaultImplementation.getAddress(),
          salt,
        );

        const tx = await vaultFactory.connect(USER1).deployVault(USER2.address, CUSTOM_TIMELOCK);
        const receipt = await tx.wait();
        const actualAddress = receipt?.logs[0]?.address;

        expect(actualAddress).to.equal(predictedAddress);
      });
    });

    describe("Factory Sync Functionality", () => {
      let deployedVault: Vault;
      let vaultAddress: string;

      beforeEach(async () => {
        const tx = await vaultFactory.connect(USER1).deployVault(USER2.address, CUSTOM_TIMELOCK);
        const receipt = await tx.wait();
        vaultAddress = receipt?.logs[0]?.address!;
        deployedVault = await ethers.getContractAt("Vault", vaultAddress);
      });

      it("should automatically sync factory ownership records on recovery execution", async () => {
        // Cancel initial recovery and initiate recovery
        await deployedVault.connect(USER1).cancelRecovery();
        await deployedVault.connect(USER2).initiateRecovery(NEW_OWNER.address);

        // Advance time past timelock
        await time.increase(CUSTOM_TIMELOCK + 1);

        // Execute recovery
        await expect(deployedVault.executeRecovery())
          .to.emit(deployedVault, "RecoveryExecuted")
          .withArgs(OWNER.address, NEW_OWNER.address);

        // Check that vault ownership changed
        expect(await deployedVault.owner()).to.equal(NEW_OWNER.address);

        // Check that factory records were automatically synced
        const user1Vaults = await vaultFactory.getVaultsByOwner(USER1.address);
        const newOwnerVaults = await vaultFactory.getVaultsByOwner(NEW_OWNER.address);
        expect(user1Vaults).to.have.lengthOf(0);
        expect(newOwnerVaults).to.have.lengthOf(1);
        expect(newOwnerVaults[0]).to.equal(vaultAddress);
        expect(await vaultFactory.vaultToOwner(vaultAddress)).to.equal(NEW_OWNER.address);
      });

      it("should allow manual sync of vault ownership", async () => {
        // Manually transfer ownership (not through recovery)
        await deployedVault.connect(USER1).transferOwnership(NEW_OWNER.address);

        // Factory records should be stale initially
        let user1Vaults = await vaultFactory.getVaultsByOwner(USER1.address);
        let newOwnerVaults = await vaultFactory.getVaultsByOwner(NEW_OWNER.address);
        expect(user1Vaults).to.have.lengthOf(1);
        expect(user1Vaults[0]).to.equal(vaultAddress);
        expect(newOwnerVaults).to.have.lengthOf(0);
        expect(await vaultFactory.vaultToOwner(vaultAddress)).to.equal(USER1.address);

        // Sync manually
        await expect(vaultFactory.syncOwner(vaultAddress))
          .to.emit(vaultFactory, "VaultOwnerChanged")
          .withArgs(vaultAddress, NEW_OWNER.address);

        // Factory records should now be updated
        user1Vaults = await vaultFactory.getVaultsByOwner(USER1.address);
        newOwnerVaults = await vaultFactory.getVaultsByOwner(NEW_OWNER.address);
        expect(user1Vaults).to.have.lengthOf(0);
        expect(newOwnerVaults).to.have.lengthOf(1);
        expect(newOwnerVaults[0]).to.equal(vaultAddress);
        expect(await vaultFactory.vaultToOwner(vaultAddress)).to.equal(NEW_OWNER.address);
      });

      it("should revert sync for non-existent vault", async () => {
        const nonExistentVault = "0x1234567890123456789012345678901234567890";
        await expect(vaultFactory.syncOwner(nonExistentVault)).to.be.revertedWithCustomError(
          vaultFactory,
          "VaultNotFound",
        );
      });

      it("should handle sync when owner hasn't changed", async () => {
        // Sync should not emit event if owner hasn't changed
        await expect(vaultFactory.syncOwner(vaultAddress)).to.not.emit(vaultFactory, "VaultOwnerChanged");

        // Factory records should remain the same
        const user1Vaults = await vaultFactory.getVaultsByOwner(USER1.address);
        expect(user1Vaults).to.have.lengthOf(1);
        expect(user1Vaults[0]).to.equal(vaultAddress);
        expect(await vaultFactory.vaultToOwner(vaultAddress)).to.equal(USER1.address);
      });
    });

    describe("View Functions", () => {
      beforeEach(async () => {
        await vaultFactory.connect(USER1).deployVault(USER2.address, CUSTOM_TIMELOCK);
      });

      it("should return correct vaults by owner", async () => {
        const user1Vaults = await vaultFactory.getVaultsByOwner(USER1.address);
        const user2Vaults = await vaultFactory.getVaultsByOwner(USER2.address);
        
        expect(user1Vaults).to.have.lengthOf(1);
        expect(user1Vaults[0]).to.not.equal(ethers.ZeroAddress);
        expect(user2Vaults).to.have.lengthOf(0);
      });

      it("should return correct owner by vault", async () => {
        const user1Vaults = await vaultFactory.getVaultsByOwner(USER1.address);
        const vaultAddress = user1Vaults[0];
        expect(await vaultFactory.getOwnerByVault(vaultAddress)).to.equal(USER1.address);
      });

      it("should check vault existence correctly", async () => {
        expect(await vaultFactory.hasVaults(USER1.address)).to.be.true;
        expect(await vaultFactory.hasVaults(USER2.address)).to.be.false;
      });

      it("should return correct vault count by owner", async () => {
        expect(await vaultFactory.getVaultCountByOwner(USER1.address)).to.equal(1);
        expect(await vaultFactory.getVaultCountByOwner(USER2.address)).to.equal(0);
        
        // Deploy another vault for USER1
        await vaultFactory.connect(USER1).deployVault(USER2.address, CUSTOM_TIMELOCK);
        expect(await vaultFactory.getVaultCountByOwner(USER1.address)).to.equal(2);
      });

      it("should return vault by owner and index", async () => {
        const user1Vaults = await vaultFactory.getVaultsByOwner(USER1.address);
        const vaultByIndex = await vaultFactory.getVaultByOwnerAndIndex(USER1.address, 0);
        expect(vaultByIndex).to.equal(user1Vaults[0]);
      });

      it("should check if vault is owned by specific owner", async () => {
        const user1Vaults = await vaultFactory.getVaultsByOwner(USER1.address);
        const vaultAddress = user1Vaults[0];
        
        expect(await vaultFactory.isVaultOwnedBy(USER1.address, vaultAddress)).to.be.true;
        expect(await vaultFactory.isVaultOwnedBy(USER2.address, vaultAddress)).to.be.false;
      });
    });

    describe("Admin Functions", () => {
      it("should allow owner to set new implementation", async () => {
        const newImplementation = await ethers.deployContract("Vault");

        await expect(vaultFactory.connect(OWNER).setVaultImplementation(await newImplementation.getAddress())).to.emit(
          vaultFactory,
          "ImplementationChanged",
        );

        expect(await vaultFactory.vaultImplementation()).to.equal(await newImplementation.getAddress());
      });

      it("should revert if non-owner tries to set implementation", async () => {
        const newImplementation = await ethers.deployContract("Vault");

        await expect(
          vaultFactory.connect(USER1).setVaultImplementation(await newImplementation.getAddress()),
        ).to.be.revertedWithCustomError(vaultFactory, "OwnableUnauthorizedAccount");
      });
    });

    describe("Upgradability", () => {
      it("should allow owner to upgrade factory", async () => {
        const newImplementation = await ethers.deployContract("VaultFactory");
        const newImplementationAddress = await newImplementation.getAddress();

        const currentImplementationAddress = await vaultFactory.implementation();
        expect(currentImplementationAddress).to.not.equal(newImplementationAddress);

        await vaultFactory.connect(OWNER).upgradeToAndCall(newImplementationAddress, "0x");

        expect(await vaultFactory.implementation()).to.equal(newImplementationAddress);
      });

      it("should revert if non-owner tries to upgrade factory", async () => {
        const newImplementation = await ethers.deployContract("VaultFactory");
        const newImplementationAddress = await newImplementation.getAddress();

        await expect(
          vaultFactory.connect(USER1).upgradeToAndCall(newImplementationAddress, "0x"),
        ).to.be.revertedWithCustomError(vaultFactory, "OwnableUnauthorizedAccount");
      });
    });

    describe("Recovery Key Enumeration", () => {
      let vault1Address: string;
      let vault2Address: string;
      let vault3Address: string;

      beforeEach(async () => {
        // Deploy multiple vaults with different recovery keys
        const tx1 = await vaultFactory.connect(USER1).deployVault(RECOVERY_KEY.address, CUSTOM_TIMELOCK);
        const receipt1 = await tx1.wait();
        vault1Address = receipt1?.logs[0]?.address!;

        const tx2 = await vaultFactory.connect(USER2).deployVault(RECOVERY_KEY.address, CUSTOM_TIMELOCK);
        const receipt2 = await tx2.wait();
        vault2Address = receipt2?.logs[0]?.address!;

        const tx3 = await vaultFactory.connect(ATTACKER).deployVault(NEW_OWNER.address, CUSTOM_TIMELOCK);
        const receipt3 = await tx3.wait();
        vault3Address = receipt3?.logs[0]?.address!;
      });

      it("should track vaults by recovery key correctly", async () => {
        // Check RECOVERY_KEY has 3 vaults (main vault + vault1Address + vault2Address)
        const vaultsByRecoveryKey = await vaultFactory.getVaultsByRecoveryKey(RECOVERY_KEY.address);
        expect(vaultsByRecoveryKey).to.have.lengthOf(3);
        expect(vaultsByRecoveryKey).to.include(vault1Address);
        expect(vaultsByRecoveryKey).to.include(vault2Address);
        expect(vaultsByRecoveryKey).to.include(await vault.getAddress());

        // Check NEW_OWNER has 1 vault
        const vaultsByNewOwner = await vaultFactory.getVaultsByRecoveryKey(NEW_OWNER.address);
        expect(vaultsByNewOwner).to.have.lengthOf(1);
        expect(vaultsByNewOwner[0]).to.equal(vault3Address);

        // Check USER1 has no vaults as recovery key
        const vaultsByUser1 = await vaultFactory.getVaultsByRecoveryKey(USER1.address);
        expect(vaultsByUser1).to.have.lengthOf(0);
      });

      it("should return empty array for non-existent recovery key", async () => {
        const vaultsByUnknownKey = await vaultFactory.getVaultsByRecoveryKey(ethers.Wallet.createRandom().address);
        expect(vaultsByUnknownKey).to.have.lengthOf(0);
      });

      it("should handle multiple vaults for same recovery key", async () => {
        const tx = await vaultFactory.connect(NEW_OWNER).deployVault(RECOVERY_KEY.address, CUSTOM_TIMELOCK);
        const receipt = await tx.wait();
        const vault4Address = receipt?.logs[0]?.address!;

        const vaultsByRecoveryKey = await vaultFactory.getVaultsByRecoveryKey(RECOVERY_KEY.address);
        expect(vaultsByRecoveryKey).to.have.lengthOf(4);
        expect(vaultsByRecoveryKey).to.include(vault1Address);
        expect(vaultsByRecoveryKey).to.include(vault2Address);
        expect(vaultsByRecoveryKey).to.include(await vault.getAddress());
        expect(vaultsByRecoveryKey).to.include(vault4Address);
      });

      it("should maintain correct enumeration after ownership changes", async () => {
        // Execute recovery on vault1 to change ownership
        const vault1 = await ethers.getContractAt("Vault", vault1Address);

        // Cancel initial recovery and initiate new recovery
        await vault1.connect(USER1).cancelRecovery();
        await vault1.connect(RECOVERY_KEY).initiateRecovery(NEW_OWNER.address);

        // Advance time past timelock
        await time.increase(CUSTOM_TIMELOCK + 1);

        // Execute recovery
        await vault1.executeRecovery();

        // Verify ownership changed
        expect(await vault1.owner()).to.equal(NEW_OWNER.address);

        // Recovery key enumeration should still show the vault
        // (recovery key association doesn't change with ownership transfer)
        const vaultsByRecoveryKey = await vaultFactory.getVaultsByRecoveryKey(RECOVERY_KEY.address);
        expect(vaultsByRecoveryKey).to.have.lengthOf(3);
        expect(vaultsByRecoveryKey).to.include(vault1Address);
        expect(vaultsByRecoveryKey).to.include(vault2Address);
        expect(vaultsByRecoveryKey).to.include(await vault.getAddress());
      });
    });
  });
});
