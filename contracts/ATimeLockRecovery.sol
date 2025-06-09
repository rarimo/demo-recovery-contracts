// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

/**
 * @notice An abstraction of the Ownable contract that allows to set the recovery key,
 * which then can be used to transfer ownership to the new account.
 */
abstract contract ATimeLockRecovery is Initializable, OwnableUpgradeable {
    struct RecoveryRequest {
        address newOwner;
        uint256 executeAfter;
        bool isActive;
    }

    /// @notice The address that can initiate recovery
    address public recoveryKey;

    /// @notice The time delay required before recovery can be executed
    uint256 public timelock;

    /// @notice Current active recovery request
    RecoveryRequest public recoveryRequest;

    event RecoveryKeySet(address previousRecoveryKey, address newRecoveryKey);
    event RecoveryInitiated(address initiator, address newOwner, uint256 executeAfter);
    event RecoveryExecuted(address executor, address newOwner);
    event RecoveryCanceled(address canceler);
    event TimelockUpdated(uint256 previousTimelock, uint256 newTimelock);

    error NoActiveRecovery();
    error RecoveryStillLocked(uint256 currentTime, uint256 recoveryTime);
    error RecoveryAlreadyActive(uint256 timeUntilRecovery, address newOwner);
    error InvalidRecoveryKey();
    error InvalidTimelock();
    error UnauthorizedRecoveryAction();

    modifier onlyRecoveryKey() {
        require(msg.sender == recoveryKey, UnauthorizedRecoveryAction());
        _;
    }

    function __ATimeLockRecovery_init(
        address initialOwner_,
        address recoveryKey_,
        uint256 timelock_
    ) internal onlyInitializing {
        __Ownable_init(initialOwner_);

        timelock = timelock_;
        recoveryKey = recoveryKey_;
    }

    /**
     * @notice Set the recovery key address
     * @param newRecoveryKey_ The new recovery key address
     */
    function setRecoveryKey(address newRecoveryKey_) external virtual onlyOwner {
        require(newRecoveryKey_ != address(0), InvalidRecoveryKey());

        address previousRecoveryKey_ = recoveryKey;
        recoveryKey = newRecoveryKey_;

        emit RecoveryKeySet(previousRecoveryKey_, newRecoveryKey_);
    }

    /**
     * @notice Set the timelock duration
     * @param newTimelock_ The new timelock duration in seconds
     */
    function setTimelock(uint256 newTimelock_) external virtual onlyOwner {
        require(newTimelock_ != 0, InvalidTimelock());

        uint256 previousTimelock_ = timelock;
        timelock = newTimelock_;

        emit TimelockUpdated(previousTimelock_, newTimelock_);
    }

    /**
     * @notice Initiate recovery process
     * @param newOwner_ The address that will become the new owner after timelock
     */
    function initiateRecovery(address newOwner_) external virtual onlyRecoveryKey {
        require(
            !recoveryRequest.isActive,
            RecoveryAlreadyActive(recoveryRequest.executeAfter, recoveryRequest.newOwner)
        );

        uint256 executeAfter_ = block.timestamp + timelock;

        recoveryRequest = RecoveryRequest({
            newOwner: newOwner_,
            executeAfter: executeAfter_,
            isActive: true
        });

        emit RecoveryInitiated(msg.sender, newOwner_, executeAfter_);
    }

    /**
     * @notice Execute the recovery if timelock has passed
     */
    function executeRecovery() external virtual;

    /**
     * @notice Cancel an active recovery request
     */
    function cancelRecovery() external virtual {
        require(recoveryRequest.isActive, NoActiveRecovery());
        require(msg.sender == owner() || msg.sender == recoveryKey, UnauthorizedRecoveryAction());

        recoveryRequest.isActive = false;

        delete recoveryRequest;

        emit RecoveryCanceled(msg.sender);
    }

    /**
     * @notice Get the current recovery key
     * @return The recovery key address
     */
    function getRecoveryKey() external view returns (address) {
        return recoveryKey;
    }

    /**
     * @notice Get the current timelock duration
     * @return The timelock duration in seconds
     */
    function getTimelock() external view returns (uint256) {
        return timelock;
    }

    /**
     * @notice Get the current recovery request
     * @return The recovery request struct
     */
    function getRecoveryRequest() external view returns (RecoveryRequest memory) {
        return recoveryRequest;
    }

    /**
     * @notice Check if recovery can be executed now
     * @return True if recovery can be executed
     */
    function canExecuteRecovery() public view returns (bool) {
        return recoveryRequest.isActive && block.timestamp >= recoveryRequest.executeAfter;
    }

    /**
     * @notice Get time remaining until recovery can be executed
     * @return Time in seconds until recovery can be executed (0 if can execute now)
     */
    function getTimeUntilRecovery() external view returns (uint256) {
        if (!recoveryRequest.isActive) {
            return 0;
        }

        if (block.timestamp >= recoveryRequest.executeAfter) {
            return 0;
        }

        return recoveryRequest.executeAfter - block.timestamp;
    }
}
