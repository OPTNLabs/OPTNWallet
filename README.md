# OPTN Wallet Developer Onboarding

Welcome to the OPTN Wallet project! This guide is designed to help you get started with the development environment, understand the project layout, and build the application for web and mobile platforms. For more information about the project, visit our [website](https://optn-website.vercel.app/).

## Project Structure

The project is organized to clearly separate frontend components, API interactions, and backend services. Here’s a breakdown of the key directories and files:

- **Root Configuration & Build Files:**

  - `.editorconfig`, `.eslintrc.cjs`, `.eslintrc.json`, `.prettierrc` – Code style and formatting configurations.
  - `package.json`, `package-lock.json` – Project metadata and dependency management.
  - `tsconfig.json`, `tsconfig.node.json` – TypeScript configuration files.
  - `vite.config.ts` – Vite configuration for building the app.
  - `tailwind.config.js` – Tailwind CSS configuration.
  - `capacitor.config.ts` – Configuration for mobile builds using Capacitor.

- **Source Code (`src` folder):**

  - **Entry Points & Global Assets:**

    - `App.tsx` – Main React entry point.
    - `index.html`, `index.css`, `main.tsx` – Base HTML and styling files.

  - **API Modules (`src/apis`):**Modules here handle interactions with external APIs and blockchain-related operations:

    - **AddressManager** – Manages wallet addresses.
    - **ChaingraphManager** – Interacts with blockchain data graphs.
    - **ContractManager** – Manages smart contract interactions and holds contract artifacts.
    - **DatabaseManager** – Interfaces with the internal database.
    - **ElectrumServer** – Manages communication with the Electrum server.
    - **TransactionManager** – Constructs and processes transactions.
    - **UTXOManager** – Handles UTXO (Unspent Transaction Output) management.
    - **WalletManager** – Manages wallet creation, key generation, and related functions.

  - **Frontend Components (`src/components`):**Contains all reusable React components for the user interface:

    - General UI elements (e.g., `AboutView.tsx`, `BitcoinCashCard.tsx`, `WalletCreate.tsx`, etc.).
    - Specialized components organized in subdirectories like `modules` (e.g., `NetworkSwitch.tsx`) and `transaction` (e.g., `TransactionActions.tsx`).

  - **Pages (`src/pages`):**Represents the different views and routes of the application:

    - Pages like `Home.tsx`, `CreateWallet.tsx`, `ImportWallet.tsx`, `Settings.tsx`, and more.

  - **State Management (`src/redux`):**Houses Redux slices, selectors, and store configuration:

    - Files such as `contractSlice.ts`, `networkSlice.ts`, `priceFeedSlice.ts`, among others, along with selectors and the main store.

  - **Backend Services (`src/services`):**Provides additional business logic and supports API calls:

    - Services like `ElectrumService.ts`, `KeyService.ts`, `TransactionService.ts`, and `UTXOService.ts`.

  - **Custom Hooks (`src/hooks`):**Contains React hooks for handling logic like data fetching and transaction processing:

    - Files such as `useContractFunction.ts`, `useFetchWalletData.ts`, `useHandleTransaction.ts`.

  - **Utilities & Types:**

    - **Utilities (`src/utils`):**
      Includes helper functions, constants, and schema validations.
    - **Types (`src/types`):**
      TypeScript definitions for consistent type usage across the project.

  - **Web Workers (`src/workers`):**Offloads heavy computations or background tasks to separate threads:

    - Worker services like `TransactionWorkerService.ts`, `UTXOWorkerService.ts`, and `priceFeedWorker.ts`.

- **Additional Folders:**

  - **Patches (`patches` folder):**
    Contains patches applied to third-party dependencies when needed.

## Getting Started

### Repository

The source code for the OPTN Wallet is hosted on GitHub. You can find the repository at the following link:
[GitHub Repository](https://github.com/BitcoinBay/OPTNWallet)

### Local Development Build

1. **Clone the Repository**

   ```bash
   git clone https://github.com/BitcoinBay/OPTNWallet.git
   cd OPTNWallet
   ```

2. **Install Dependencies**

   ```bash
   npm install
   ```

3. **Run Development Server**

   ```bash
   npm run dev
   ```

### Building the App for Android / iOS

1. **Initialize Capacitor**

   ```bash
   npm run capacitor:init
   ```

2. **Add Android Platform**

   ```bash
   npm run capacitor:add:android
   ```

3. **Copy Web Assets**

   ```bash
   npm run capacitor:copy
   ```

4. **Sync Capacitor Plugins**

   ```bash
   npm run capacitor:sync
   ```

5. **Open Android Studio**

   ```bash
   npm run capacitor:open:android
   ```

6. **Build the Project**

   - For Android: Use Android Studio to build and run the project on an emulator or a physical device.
   - For iOS: Open the `ios` folder in Xcode and build the project.

### Available Scripts

- **Start Development Server:** `npm run dev`
- **Build for Production:** `npm run build`
- **Lint the Code:** `npm run lint`
- **Preview the Production Build:** `npm run preview`
- **Format the Code:** `npm run format`
- **Serve the Production Build:** `npm run serve`

## Contribution & Contact

We welcome contributions from the community! Join our [Telegram Group](https://t.me/+KLBMsVW0xHY1YWI5) to connect with the developers and other contributors.

Thank you for your interest in the OPTN Wallet project!
