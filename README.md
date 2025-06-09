# Demo Recovery Contracts

This project demonstrates a time-locked recovery system for Ethereum vaults, allowing designated recovery keys to 
initiate ownership transfers after a configurable timelock period.

## Recovery Flow

```mermaid
sequenceDiagram
    participant Factory as VaultFactory
    participant Owner
    participant RecoveryKey
    participant Vault
    participant Anyone
    participant NewOwner

    Note over Factory,NewOwner: Vault Deployment
    Factory->>Vault: deployVault(owner, recoveryKey, timelock)
    Vault-->>Factory: Store owner mapping
    Factory-->>Owner: Vault deployed

    Note over Factory,NewOwner: Normal Operations
    Owner->>Vault: deposit ETH
    Owner->>Vault: withdraw ETH
    Owner->>Vault: setRecoveryKey
    Owner->>Vault: setTimelock

    Note over Factory,NewOwner: Recovery Process
    RecoveryKey->>Vault: initiateRecovery(newOwner)
    Vault-->>Vault: Set recovery request with timelock
    
    Note over Factory,NewOwner: Timelock Period
    
    alt Owner cancels recovery
        Owner->>Vault: cancelRecovery()
        Vault-->>Vault: Clear recovery request
    else Recoverer cancels recovery
        RecoveryKey->>Vault: cancelRecovery()
        Vault-->>Vault: Clear recovery request
    else Timelock expires
        Anyone->>Vault: executeRecovery()
        Vault-->>Vault: Transfer ownership to newOwner
        Vault->>Factory: syncOwner(vault) - Automatic sync
        Factory-->>Factory: Update ownership mapping
        Vault-->>NewOwner: Ownership transferred
    end

    Note over Factory,NewOwner: Manual Factory Sync (if needed)
    alt Owner changes outside recovery
        Owner->>Vault: transferOwnership(newOwner)
        Vault-->>NewOwner: Ownership transferred
        Anyone->>Factory: syncOwner(vault) - Manual sync
        Factory-->>Factory: Update ownership mapping
    end

    Note over Factory,NewOwner: Emergency Withdrawal (only when recovery is executable)
    alt Recovery is active AND timelock has expired
        RecoveryKey->>Vault: emergencyWithdraw(to, amount)
        Note right of Vault: Conditions:<br/>1. Recovery request exists<br/>2. block.timestamp >= executeAfter<br/>3. Only recovery key can call
        Vault-->>Vault: Clear recovery request
        Vault-->>RecoveryKey: Transfer ETH to specified address
    end
```

## Development

#### Compilation

To compile the contracts, use the next script:

```bash
npm run compile
```

#### Test

To run the tests, execute the following command:

```bash
npm run test
```

Or to see the coverage, run:

```bash
npm run coverage
```

#### Local deployment

To deploy the contracts locally, run the following commands (in the different terminals):

```bash
npm run private-network
npm run deploy-localhost
```

#### Bindings

The command to generate the bindings is as follows:

```bash
npm run generate-types
```

> See the full list of available commands in the `package.json` file.

