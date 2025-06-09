// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

import {Vault} from "./Vault.sol";

import {IVaultFactory} from "./interfaces/IVaultFactory.sol";

/**
 * @title VaultFactory
 * @notice Factory contract for deploying Vault instances using CREATE2
 */
contract VaultFactory is Initializable, OwnableUpgradeable, UUPSUpgradeable {
    using EnumerableSet for EnumerableSet.AddressSet;

    /// @notice Implementation address for Vault contracts
    address public vaultImplementation;

    /// @notice Mapping from owner to their vault address
    mapping(address => address) public vaultsByOwner;

    /// @notice Mapping from vault address to owner
    mapping(address => address) public vaultToOwner;

    /// @notice Mapping from recovery key to set of vaults they can recover
    mapping(address => EnumerableSet.AddressSet) private _vaultsByRecoveryKey;

    event VaultDeployed(address indexed vault, address indexed owner);
    event VaultOwnerChanged(address indexed vault, address indexed newOwner);
    event ImplementationChanged(address indexed newImplementation);

    error VaultAlreadyExists(address vault);
    error VaultNotFound();
    error Unauthorized(address caller, address owner);

    /**
     * @notice Initialize the VaultFactory
     * @param vaultImplementation_ Address of the Vault implementation contract
     * @param initialOwner_ Address that will be the initial owner of the factory
     */
    function __VaultFactory_init(
        address vaultImplementation_,
        address initialOwner_
    ) external initializer {
        __Ownable_init(initialOwner_);

        vaultImplementation = vaultImplementation_;
    }

    /**
     * @notice Deploy a new Vault for the specified owner
     * @param owner_ The address that will own the vault
     * @param recoveryKey_ The address that can initiate recovery
     * @param timelock_ The timelock duration for recovery (0 for default 7 days)
     * @return vault_ The address of the deployed vault
     */
    function deployVault(
        address owner_,
        address recoveryKey_,
        uint256 timelock_
    ) external returns (address vault_) {
        require(vaultsByOwner[owner_] == address(0), VaultAlreadyExists(vaultsByOwner[owner_]));

        Vault vault = Vault(
            payable(_deploy2(vaultImplementation, bytes32(uint256(uint160(owner_)))))
        );

        vault.__Vault_init(owner_, recoveryKey_, timelock_, address(this));

        vaultsByOwner[owner_] = address(vault);
        vaultToOwner[address(vault)] = owner_;

        _vaultsByRecoveryKey[recoveryKey_].add(address(vault));

        emit VaultDeployed(address(vault), owner_);

        return address(vault);
    }

    function syncOwner(address vault_) external {
        address oldOwner_ = vaultToOwner[vault_];
        require(oldOwner_ != address(0), VaultNotFound());

        address newOwner_ = Vault(payable(vault_)).owner();

        if (newOwner_ != oldOwner_) {
            if (vaultsByOwner[oldOwner_] == vault_) {
                vaultsByOwner[oldOwner_] = address(0);
            }

            vaultsByOwner[newOwner_] = vault_;
            vaultToOwner[vault_] = newOwner_;

            emit VaultOwnerChanged(vault_, newOwner_);
        }
    }

    /**
     * @notice Get all vaults that can be recovered by a specific recovery key
     */
    function getVaultsByRecoveryKey(address recoveryKey_) external view returns (address[] memory) {
        return _vaultsByRecoveryKey[recoveryKey_].values();
    }

    /**
     * @notice Set the implementation address for new vault deployments
     * @param newImplementation_ Address of the new Vault implementation
     * @dev Only callable by factory owner
     */
    function setVaultImplementation(address newImplementation_) external onlyOwner {
        vaultImplementation = newImplementation_;

        emit ImplementationChanged(newImplementation_);
    }

    /**
     * @notice Get the vault address for a specific owner
     * @param owner_ The owner address to query
     * @return The vault address (zero if no vault exists)
     */
    function getVaultByOwner(address owner_) external view returns (address) {
        return vaultsByOwner[owner_];
    }

    /**
     * @notice Get the owner of a specific vault
     * @param vault_ The vault address to query
     * @return The owner address (zero if vault not found)
     */
    function getOwnerByVault(address vault_) external view returns (address) {
        return vaultToOwner[vault_];
    }

    /**
     * @notice Check if a vault exists for the given owner
     * @param owner_ The owner address to check
     * @return True if vault exists
     */
    function isVaultExists(address owner_) external view returns (bool) {
        return vaultsByOwner[owner_] != address(0);
    }

    /**
     * @notice Predict the address of a vault before deployment
     * @param implementation_ The implementation address
     * @param owner_ The owner address (used as salt)
     * @return The predicted vault address
     */
    function predictVaultAddress(
        address implementation_,
        address owner_
    ) external view returns (address) {
        return _predictAddress(implementation_, bytes32(uint256(uint160(owner_))));
    }

    /**
     * @notice Get the current vault implementation address
     * @return The implementation address
     */
    function getVaultImplementation() external view returns (address) {
        return vaultImplementation;
    }

    /**
     * @notice Get the current factory implementation address
     * @return The factory implementation address
     */
    function implementation() external view returns (address) {
        return ERC1967Utils.getImplementation();
    }

    /**
     * @notice Deploy a contract using CREATE2
     * @param implementation_ The implementation address
     * @param salt_ The salt for CREATE2
     * @return The deployed contract address
     */
    function _deploy2(address implementation_, bytes32 salt_) internal returns (address payable) {
        return payable(address(new ERC1967Proxy{salt: salt_}(implementation_, new bytes(0))));
    }

    /**
     * @notice Predict the address of a contract deployed with CREATE2
     * @param implementation_ The implementation address
     * @param salt_ The salt for CREATE2
     * @return The predicted contract address
     */
    function _predictAddress(
        address implementation_,
        bytes32 salt_
    ) internal view returns (address) {
        bytes32 bytecodeHash_ = keccak256(
            abi.encodePacked(
                type(ERC1967Proxy).creationCode,
                abi.encode(implementation_, new bytes(0))
            )
        );

        return Create2.computeAddress(salt_, bytecodeHash_);
    }

    /**
     * @notice Authorize upgrade (UUPS pattern)
     * @param newImplementation_ The new implementation address
     * @dev Only callable by factory owner
     */
    // solhint-disable-next-line no-empty-blocks
    function _authorizeUpgrade(address newImplementation_) internal override onlyOwner {}
}
