# Demo Recovery Contracts

This project demonstrates a time-locked recovery system for Ethereum vaults, allowing designated recovery keys to 
initiate ownership transfers after a configurable timelock period.

## Recovery Flow

```mermaid
sequenceDiagram
    participant Owner
    participant RecoveryKey
    participant Vault
    participant Anyone
    participant NewOwner

    Note over Owner,NewOwner: Normal Operations
    Owner->>Vault: deposit ETH
    Owner->>Vault: withdraw ETH
    Owner->>Vault: setRecoveryKey
    Owner->>Vault: setTimelock

    Note over Owner,NewOwner: Recovery Process
    RecoveryKey->>Vault: initiateRecovery(newOwner)
    Vault-->>Vault: Set recovery request with timelock
    
    Note over Owner,NewOwner: Timelock Period (default 7 days)
    
    alt Owner cancels recovery
        Owner->>Vault: cancelRecovery()
        Vault-->>Vault: Clear recovery request
    else Recovery key cancels
        RecoveryKey->>Vault: cancelRecovery()
        Vault-->>Vault: Clear recovery request
    else Timelock expires
        Anyone->>Vault: executeRecovery()
        Vault-->>Vault: Transfer ownership to newOwner
        Vault-->>NewOwner: Ownership transferred
    end

    Note over Owner,NewOwner: Emergency Withdrawal (only when recovery is executable)
    alt Recovery is active AND timelock has expired
        RecoveryKey->>Vault: emergencyWithdraw(to, amount)
        Note right of Vault: Conditions:<br/>1. Recovery request exists<br/>2. block.timestamp >= executeAfter<br/>3. Only recovery key can call
        Vault-->>RecoveryKey: Transfer ETH to specified address
    end
```

## Architecture

- **ATimeLockRecovery**: Abstract base contract providing time-locked recovery functionality
- **Vault**: Concrete implementation for ETH storage with recovery capabilities  
- **VaultFactory**: Upgradeable factory for deploying vault instances with CREATE2

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

