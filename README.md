# OPTN Wallet Developer Onboarding

Welcome to the OPTN Wallet project! This guide helps you set up the development environment, understand the project structure, and build the application for web and mobile platforms. For more details, visit our [website](https://www.optnwallet.com/).

## Project Structure

The project is organized to separate frontend components, API interactions, and backend services. Below is a breakdown of key directories and files:

- **Root Configuration & Build Files**:
  - `.editorconfig`, `.eslintrc.cjs`, `.eslintrc.json`, `.prettierrc`: Code style and formatting configurations.
  - `package.json`, `package-lock.json`: Project metadata and dependency management.
  - `tsconfig.json`, `tsconfig.node.json`: TypeScript configuration files.
  - `vite.config.ts`: Vite configuration for building the app.
  - `tailwind.config.js`: Tailwind CSS configuration.
  - `capacitor.config.ts`: Configuration for mobile builds using Capacitor.

- **Source Code (`src`)**:
  - **Entry Points & Global Assets**:
    - `App.tsx`: Main React entry point.
    - `index.html`, `index.css`, `main.tsx`: Base HTML and styling files.
  - **API Modules (`src/apis`)**: Handles interactions with external APIs and blockchain operations:
    - `AddressManager`: Manages wallet addresses.
    - `ChaingraphManager`: Interacts with blockchain data graphs.
    - `ContractManager`: Manages smart contract interactions and holds contract artifacts.
    - `DatabaseManager`: Interfaces with the internal database.
    - `ElectrumServer`: Manages communication with the Electrum server.
    - `TransactionManager`: Constructs and processes transactions.
    - `UTXOManager`: Handles UTXO (Unspent Transaction Output) management.
    - `WalletManager`: Manages wallet creation, key generation, and related functions.
  - **Frontend Components (`src/components`)**: Contains reusable React components for the user interface:
    - General UI elements (e.g., `AboutView.tsx`, `BitcoinCashCard.tsx`, `WalletCreate.tsx`).
    - Specialized components in subdirectories like `modules` (e.g., `NetworkSwitch.tsx`) and `transaction` (e.g., `TransactionActions.tsx`).
  - **Pages (`src/pages`)**: Represents the application's views and routes:
    - Pages like `Home.tsx`, `CreateWallet.tsx`, `ImportWallet.tsx`, `Settings.tsx`.
  - **State Management (`src/redux`)**: Houses Redux slices, selectors, and store configuration:
    - Files like `contractSlice.ts`, `networkSlice.ts`, `priceFeedSlice.ts`, along with selectors and the main store.
  - **Backend Services (`src/services`)**: Provides business logic and supports API calls:
    - Services like `ElectrumService.ts`, `KeyService.ts`, `TransactionService.ts`, `UTXOService.ts`.
  - **Custom Hooks (`src/hooks`)**: Contains React hooks for logic like data fetching and transaction processing:
    - Files like `useContractFunction.ts`, `useFetchWalletData.ts`, `useHandleTransaction.ts`.
  - **Utilities & Types**:
    - `src/utils`: Helper functions, constants, and schema validations.
    - `src/types`: TypeScript definitions for consistent type usage.
  - **Web Workers (`src/workers`)**: Offloads heavy computations to separate threads:
    - Worker services like `TransactionWorkerService.ts`, `UTXOWorkerService.ts`, `priceFeedWorker.ts`.

- **Additional Folders**:
  - **Patches (`patches`)**: Contains patches for third-party dependencies when needed.

## Getting Started

### Repository

The source code is hosted on GitHub: [OPTN Wallet Repository](https://github.com/OPTNLabs/OPTNWallet)

### Local Development Build

1. **Clone the Repository**:
   ```bash
   git clone https://github.com/OPTNLabs/OPTNWallet.git
   cd OPTNWallet


