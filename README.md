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



```
OPTNWallet
├─ .editorconfig
├─ .eslintrc.cjs
├─ .eslintrc.json
├─ .prettierrc
├─ LICENSE
├─ README.md
├─ build.sh
├─ capacitor.config.ts
├─ index.html
├─ module.d.ts
├─ package-lock.json
├─ package.json
├─ postcss.config.js
├─ releaseBuild.sh
├─ resources
│  └─ splash.png
├─ src
│  ├─ App.tsx
│  ├─ apis
│  │  ├─ AddressManager
│  │  │  └─ AddressManager.ts
│  │  ├─ ChaingraphManager
│  │  │  └─ ChaingraphManager.ts
│  │  ├─ ContractManager
│  │  │  ├─ ContractManager.tsx
│  │  │  └─ artifacts
│  │  │     ├─ AuthGuard.json
│  │  │     ├─ MSVault.json
│  │  │     ├─ announcement.json
│  │  │     ├─ bip38.json
│  │  │     ├─ escrow.json
│  │  │     ├─ escrowMS2.json
│  │  │     ├─ p2pkh.json
│  │  │     └─ transfer_with_timeout.json
│  │  ├─ DatabaseManager
│  │  │  ├─ DatabaseService.ts
│  │  │  └─ TempDatabaseService.ts
│  │  ├─ ElectrumServer
│  │  │  ├─ ElectrumServer copy.ts
│  │  │  ├─ ElectrumServer.ts
│  │  │  └─ ElectrumServerTemp.ts
│  │  ├─ TransactionManager
│  │  │  ├─ TransactionBuilderHelper.ts
│  │  │  └─ TransactionManager.ts
│  │  ├─ UTXOManager
│  │  │  └─ UTXOManager.ts
│  │  └─ WalletManager
│  │     ├─ KeyGeneration copy.ts
│  │     ├─ KeyGeneration.ts
│  │     ├─ KeyManager copy.ts
│  │     ├─ KeyManager.ts
│  │     ├─ WalletManager.ts
│  │     └─ __tests__
│  │        └─ KeyGeneration.copy.test.ts
│  ├─ assets
│  │  ├─ OPTNWelcome1.png
│  │  └─ bcmr-optn-local.json
│  ├─ components
│  │  ├─ AboutView.tsx
│  │  ├─ AddressSelectionPopup.tsx
│  │  ├─ BitcoinCashCard copy.tsx
│  │  ├─ BitcoinCashCard.tsx
│  │  ├─ BottomNavBar.tsx
│  │  ├─ CashTokenCard.tsx
│  │  ├─ CashTokenUTXOs.tsx
│  │  ├─ ContactUs.tsx
│  │  ├─ ContractDetails.tsx
│  │  ├─ ContractModal.tsx
│  │  ├─ DAppConnectionTester.tsx
│  │  ├─ ErrorBoundary.tsx
│  │  ├─ FaucetView.tsx
│  │  ├─ InteractWithContractPopup.tsx
│  │  ├─ Layout.tsx
│  │  ├─ Popup.tsx
│  │  ├─ PriceFeed copy.tsx
│  │  ├─ PriceFeed.tsx
│  │  ├─ RecoveryPhrase.tsx
│  │  ├─ RegularUTXOs.tsx
│  │  ├─ SelectContractFunctionPopup.tsx
│  │  ├─ SessionProposalModal.tsx
│  │  ├─ SweepPaperWallet.tsx
│  │  ├─ TermsOfUse.tsx
│  │  ├─ TokenQuery backup.tsx
│  │  ├─ TokenQuery copy.tsx
│  │  ├─ TokenQuery.tsx
│  │  ├─ UTXOCard.tsx
│  │  ├─ WalletCreate.tsx
│  │  ├─ WalletImport.tsx
│  │  ├─ WcConnectionManager.tsx
│  │  ├─ blockheader.tsx
│  │  ├─ modules
│  │  │  └─ NetworkSwitch.tsx
│  │  ├─ notifications
│  │  │  └─ UtxoNotificationCenter.tsx
│  │  ├─ transaction
│  │  │  ├─ AddressSelection.tsx
│  │  │  ├─ AvailableUTXOsDisplay.tsx
│  │  │  ├─ CashTokenView.tsx
│  │  │  ├─ ErrorAndStatusPopups.tsx
│  │  │  ├─ NFTConfigPopup.tsx
│  │  │  ├─ NFTView.tsx
│  │  │  ├─ OpReturnView.tsx
│  │  │  ├─ OutputSelection.tsx
│  │  │  ├─ Popup.tsx
│  │  │  ├─ RegularTxView.tsx
│  │  │  ├─ SelectedContractFunction.tsx
│  │  │  ├─ SelectedUTXOsDisplay.tsx
│  │  │  ├─ TransactionActions.tsx
│  │  │  ├─ TransactionBuilder.tsx
│  │  │  ├─ TransactionOutputsDisplay.tsx
│  │  │  ├─ TransactionTypeSelector.tsx
│  │  │  └─ UTXOSelection.tsx
│  │  └─ walletconnect
│  │     ├─ SessionList.tsx
│  │     ├─ SessionProposalModal.tsx
│  │     ├─ SessionSettingsModal.tsx
│  │     ├─ SignMessageModal.tsx
│  │     ├─ SignTransactionModal.tsx
│  │     └─ WalletConnectPanel.tsx
│  ├─ hooks
│  │  ├─ useContractFunction.ts
│  │  ├─ useFetchWalletData.ts
│  │  ├─ useHandleTransaction.ts
│  │  ├─ usePrices copy.ts
│  │  ├─ usePrices.ts
│  │  ├─ useSimpleSend.ts
│  │  └─ useTokenMetadata.ts
│  ├─ index.css
│  ├─ main.tsx
│  ├─ pages
│  │  ├─ AppsView.tsx
│  │  ├─ ContractView.tsx
│  │  ├─ CreateWallet.tsx
│  │  ├─ Home.tsx
│  │  ├─ ImportWallet.tsx
│  │  ├─ LandingPage.tsx
│  │  ├─ Receive.tsx
│  │  ├─ RootHandler.tsx
│  │  ├─ Settings.tsx
│  │  ├─ SimpleSend.tsx
│  │  ├─ Transaction.tsx
│  │  ├─ TransactionHistory.tsx
│  │  └─ apps
│  │     ├─ FundMe.tsx
│  │     └─ utils
│  │        ├─ CampaignDetail.tsx
│  │        ├─ ConsolidateModal.tsx
│  │        ├─ PledgeModal.tsx
│  │        ├─ bch.png
│  │        ├─ cashstarterCancel.tsx
│  │        ├─ cashstarterClaim.tsx
│  │        ├─ cashstarterPledge.tsx
│  │        ├─ cashstarterRefund.tsx
│  │        ├─ cashstarterStop.tsx
│  │        ├─ consolidateUTXOs.tsx
│  │        ├─ findUtxo.tsx
│  │        ├─ managerInitialize.tsx
│  │        ├─ toTokenAddress.tsx
│  │        └─ values.ts
│  ├─ polyfills
│  │  └─ node-globals.ts
│  ├─ redux
│  │  ├─ contractSlice.ts
│  │  ├─ networkSlice.ts
│  │  ├─ notificationsSlice.ts
│  │  ├─ priceFeedSlice.ts
│  │  ├─ selectors
│  │  │  └─ networkSelectors.ts
│  │  ├─ store.ts
│  │  ├─ transactionBuilderSlice.ts
│  │  ├─ transactionSlice.ts
│  │  ├─ utxoSlice.ts
│  │  ├─ walletSlice.ts
│  │  └─ walletconnectSlice.ts
│  ├─ services
│  │  ├─ BcmrService.ts
│  │  ├─ CoinSelectionService.ts
│  │  ├─ ElectrumService.ts
│  │  ├─ ElectrumSubscriptionManager.ts
│  │  ├─ KeyService.ts
│  │  ├─ Notify.ts
│  │  ├─ TransactionService.ts
│  │  ├─ UTXOService.ts
│  │  └─ priceService.ts
│  ├─ shim
│  │  ├─ net.ts
│  │  └─ tls.ts
│  ├─ types
│  │  ├─ types.ts
│  │  └─ wcInterfaces.ts
│  ├─ utils
│  │  ├─ bigIntConversion.ts
│  │  ├─ constants.ts
│  │  ├─ dataSigner.ts
│  │  ├─ derivePublicKeyHash.ts
│  │  ├─ hash.ts
│  │  ├─ hex.ts
│  │  ├─ ipfs.ts
│  │  ├─ parseExtendedJson.ts
│  │  ├─ parseInputValue.ts
│  │  ├─ schema
│  │  │  ├─ schema.ts
│  │  │  └─ tempSchema.ts
│  │  ├─ servers
│  │  │  └─ ElectrumServers.ts
│  │  ├─ shortenHash.ts
│  │  ├─ signed.ts
│  │  ├─ signedMessage.ts
│  │  └─ utxoHelpers.ts
│  ├─ vite-env.d.ts
│  └─ workers
│     ├─ TransactionWorkerService.ts
│     ├─ UTXOWorkerService.ts
│     ├─ priceFeedWorker copy.ts
│     └─ priceFeedWorker.ts
├─ tailwind.config.js
├─ test.js
├─ tsconfig.json
├─ tsconfig.node.json
├─ vite.config.ts
└─ vitest.config.ts

```