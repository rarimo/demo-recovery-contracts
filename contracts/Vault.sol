// SPDX-License-Identifier: LGPL-3.0-or-later
pragma solidity ^0.8.20;

import {Address} from "@openzeppelin/contracts/utils/Address.sol";

import {ATimeLockRecovery} from "./ATimeLockRecovery.sol";

/**
 * @title Vault
 * @notice This contract holds ETH that is managed by the owner of the contract.
 * @dev Inherits time-locked recovery functionality from ATimeLockRecovery
 */
contract Vault is ATimeLockRecovery {
    using Address for address payable;

    event Deposit(address indexed from, uint256 amount);
    event Withdrawal(address indexed to, uint256 amount);
    event EmergencyWithdrawal(address indexed to, uint256 amount);

    error WithdrawalFailed();
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
     */
    function __Vault_init(
        address initialOwner_,
        address recoveryKey_,
        uint256 timelock_
    ) external initializer {
        require(initialOwner_ != address(0), InvalidInitialOwner());
        require(recoveryKey_ != address(0), InvalidRecoveryKeyInit());
        require(timelock_ != 0, InvalidTimelockInit());

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
     * @notice Withdraw all ETH from the vault (only owner)
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
     * @dev This function can be called by the recovery key in emergency situations
     */
    function emergencyWithdraw(address payable to_, uint256 amount_) external {
        // Only allow emergency withdrawal if there's an active recovery that can be executed
        require(canExecuteRecovery(), EmergencyWithdrawalNotAvailable());
        require(msg.sender == recoveryKey, OnlyRecoveryKeyCanEmergencyWithdraw());

        require(amount_ != 0, InvalidAmount());
        require(
            amount_ <= address(this).balance,
            InsufficientBalance(amount_, address(this).balance)
        );

        to_.sendValue(amount_);

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
}
