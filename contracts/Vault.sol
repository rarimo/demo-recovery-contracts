// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {EIP712Upgradeable} from "@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol";

import {ATimeLockRecovery} from "./ATimeLockRecovery.sol";

import {IVaultFactory} from "./interfaces/IVaultFactory.sol";

/**
 * @title Vault
 * @notice This contract holds ETH that is managed by the owner of the contract.
 * @dev Inherits time-locked recovery functionality from ATimeLockRecovery
 */
contract Vault is ATimeLockRecovery, EIP712Upgradeable, Nonces {
    using Address for address payable;
    using MessageHashUtils for bytes32;

    /// @notice The factory contract that deployed this vault
    address public factory;

    /// @notice EIP712 typehash for emergency withdrawal
    bytes32 public constant EMERGENCY_WITHDRAW_TYPEHASH =
        keccak256("EmergencyWithdraw(address to,uint256 amount,uint256 nonce)");

    event Deposit(address indexed from, uint256 amount);
    event Withdrawal(address indexed to, uint256 amount);
    event EmergencyWithdrawal(address indexed to, uint256 amount);

    error InvalidAmount();
    error InvalidInitialOwner();
    error InvalidRecoveryKeyInit();
    error InvalidTimelockInit();
    error EmergencyWithdrawalNotAvailable();
    error OnlyRecoveryKeyCanEmergencyWithdraw();
    error InsufficientBalance(uint256 requested, uint256 available);

    /**
     * @notice Initialize the vault with configuration
     * @param initialOwner_ The address that will be the initial owner of the vault
     * @param recoveryKey_ The address that can initiate recovery
     * @param timelock_ The timelock duration for recovery
     * @param factory_ The factory contract that deployed this vault
     */
    function __Vault_init(
        address initialOwner_,
        address recoveryKey_,
        uint256 timelock_,
        address factory_
    ) external initializer {
        __EIP712_init("ATimeLockRecovery", "v1.0.0");

        require(initialOwner_ != address(0), InvalidInitialOwner());
        require(recoveryKey_ != address(0), InvalidRecoveryKeyInit());
        require(timelock_ != 0, InvalidTimelockInit());

        factory = factory_;

        __ATimeLockRecovery_init(initialOwner_, recoveryKey_, timelock_);
    }

    /**
     * @notice Allows the contract to receive ETH directly
     */
    receive() external payable {
        deposit();
    }

    /**
     * @notice Fallback function to receive ETH
     */
    fallback() external payable {
        deposit();
    }

    /**
     * @notice Deposit ETH into the vault
     */
    function deposit() public payable {
        require(msg.value != 0, InvalidAmount());

        emit Deposit(msg.sender, msg.value);
    }

    /**
     * @notice Withdraw ETH from the vault (only owner)
     * @param to_ The address to send ETH to
     * @param amount_ The amount of ETH to withdraw
     */
    function withdraw(address payable to_, uint256 amount_) external onlyOwner {
        require(amount_ != 0, InvalidAmount());
        require(
            amount_ <= address(this).balance,
            InsufficientBalance(amount_, address(this).balance)
        );

        to_.sendValue(amount_);

        emit Withdrawal(to_, amount_);
    }

    /**
     * @notice Withdraw all ETH from the vault
     * @param to_ The address to send ETH to
     */
    function withdrawAll(address payable to_) external onlyOwner {
        uint256 balance_ = address(this).balance;

        require(balance_ != 0, InvalidAmount());

        to_.sendValue(balance_);

        emit Withdrawal(to_, balance_);
    }

    /**
     * @notice Emergency withdrawal function that can be used during recovery
     * @param to_ The address to send ETH to
     * @param amount_ The amount of ETH to withdraw
     * @param signature_ The signature from the recovery key authorizing this withdrawal
     * @dev This function can be called by anyone with a valid signature from the recovery key
     */
    function emergencyWithdraw(
        address payable to_,
        uint256 amount_,
        bytes memory signature_
    ) external {
        require(canExecuteRecovery(), EmergencyWithdrawalNotAvailable());

        uint256 currentNonce_ = _useNonce(recoveryKey);

        // Verify EIP712 signature
        bytes32 hash_ = hashEmergencyWithdraw(to_, amount_, currentNonce_);
        require(
            SignatureChecker.isValidSignatureNow(recoveryKey, hash_, signature_),
            OnlyRecoveryKeyCanEmergencyWithdraw()
        );

        require(amount_ != 0, InvalidAmount());
        require(
            amount_ <= address(this).balance,
            InsufficientBalance(amount_, address(this).balance)
        );

        to_.sendValue(amount_);

        delete recoveryRequest;

        emit EmergencyWithdrawal(to_, amount_);
    }

    /**
     * @notice Get the current balance of the vault
     * @return The ETH balance of the vault
     */
    function getBalance() external view returns (uint256) {
        return address(this).balance;
    }

    /**
     * @notice Check if the vault has sufficient balance
     * @param amount_ The amount to check
     * @return True if vault has sufficient balance
     */
    function hasSufficientBalance(uint256 amount_) external view returns (bool) {
        return address(this).balance >= amount_;
    }

    /**
     * @notice Get the current nonce for EIP712 signatures for the recovery key
     * @return The current nonce value for the recovery key
     */
    function getRecoveryKeyNonce() external view returns (uint256) {
        return nonces(recoveryKey);
    }

    function hashEmergencyWithdraw(
        address to_,
        uint256 amount_,
        uint256 nonce_
    ) public view returns (bytes32) {
        return
            _hashTypedDataV4(
                keccak256(abi.encode(EMERGENCY_WITHDRAW_TYPEHASH, to_, amount_, nonce_))
            );
    }

    /**
     * @notice Execute the recovery if timelock has passed
     * @dev Overrides parent function to add factory sync
     */
    function executeRecovery() external virtual override {
        require(recoveryRequest.isActive, NoActiveRecovery());
        require(
            block.timestamp >= recoveryRequest.executeAfter,
            RecoveryStillLocked(block.timestamp, recoveryRequest.executeAfter)
        );

        recoveryRequest.isActive = false;

        address newOwner_ = recoveryRequest.newOwner;

        delete recoveryRequest;

        _transferOwnership(newOwner_);

        // Sync with factory if available
        if (factory != address(0)) {
            // solhint-disable-next-line no-empty-blocks
            try IVaultFactory(factory).syncOwner(address(this)) {} catch {}
        }

        emit RecoveryExecuted(msg.sender, newOwner_);
    }
}
