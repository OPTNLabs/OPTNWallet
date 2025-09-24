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
├─ android
│  ├─ .gradle
│  │  ├─ 9.0.0-rc-1
│  │  │  ├─ checksums
│  │  │  │  ├─ checksums.lock
│  │  │  │  ├─ md5-checksums.bin
│  │  │  │  └─ sha1-checksums.bin
│  │  │  ├─ executionHistory
│  │  │  │  ├─ executionHistory.bin
│  │  │  │  └─ executionHistory.lock
│  │  │  ├─ expanded
│  │  │  ├─ fileChanges
│  │  │  │  └─ last-build.bin
│  │  │  ├─ fileHashes
│  │  │  │  ├─ fileHashes.bin
│  │  │  │  ├─ fileHashes.lock
│  │  │  │  └─ resourceHashesCache.bin
│  │  │  ├─ gc.properties
│  │  │  └─ vcsMetadata
│  │  ├─ buildOutputCleanup
│  │  │  ├─ buildOutputCleanup.lock
│  │  │  ├─ cache.properties
│  │  │  └─ outputFiles.bin
│  │  ├─ file-system.probe
│  │  └─ vcs-1
│  │     └─ gc.properties
│  ├─ .kotlin
│  │  └─ sessions
│  ├─ app
│  │  ├─ build
│  │  │  ├─ generated
│  │  │  │  ├─ ap_generated_sources
│  │  │  │  │  ├─ debug
│  │  │  │  │  │  └─ out
│  │  │  │  │  └─ release
│  │  │  │  │     └─ out
│  │  │  │  └─ res
│  │  │  │     ├─ pngs
│  │  │  │     │  ├─ debug
│  │  │  │     │  └─ release
│  │  │  │     └─ resValues
│  │  │  │        ├─ debug
│  │  │  │        └─ release
│  │  │  ├─ intermediates
│  │  │  │  ├─ aar_metadata_check
│  │  │  │  │  ├─ debug
│  │  │  │  │  │  └─ checkDebugAarMetadata
│  │  │  │  │  └─ release
│  │  │  │  │     └─ checkReleaseAarMetadata
│  │  │  │  ├─ annotation_processor_list
│  │  │  │  │  ├─ debug
│  │  │  │  │  │  └─ javaPreCompileDebug
│  │  │  │  │  │     └─ annotationProcessors.json
│  │  │  │  │  └─ release
│  │  │  │  │     └─ javaPreCompileRelease
│  │  │  │  │        └─ annotationProcessors.json
│  │  │  │  ├─ apk_ide_redirect_file
│  │  │  │  │  ├─ debug
│  │  │  │  │  │  └─ createDebugApkListingFileRedirect
│  │  │  │  │  │     └─ redirect.txt
│  │  │  │  │  └─ release
│  │  │  │  │     └─ createReleaseApkListingFileRedirect
│  │  │  │  │        └─ redirect.txt
│  │  │  │  ├─ app_integrity_config
│  │  │  │  │  └─ release
│  │  │  │  │     └─ parseReleaseIntegrityConfig
│  │  │  │  ├─ app_metadata
│  │  │  │  │  ├─ debug
│  │  │  │  │  │  └─ writeDebugAppMetadata
│  │  │  │  │  │     └─ app-metadata.properties
│  │  │  │  │  └─ release
│  │  │  │  │     └─ writeReleaseAppMetadata
│  │  │  │  │        └─ app-metadata.properties
│  │  │  │  ├─ assets
│  │  │  │  │  ├─ debug
│  │  │  │  │  │  └─ mergeDebugAssets
│  │  │  │  │  │     ├─ capacitor.config.json
│  │  │  │  │  │     ├─ capacitor.plugins.json
│  │  │  │  │  │     ├─ mlkit_barcode_models
│  │  │  │  │  │     │  ├─ barcode_ssd_mobilenet_v1_dmp25_quant.tflite
│  │  │  │  │  │     │  ├─ oned_auto_regressor_mobile.tflite
│  │  │  │  │  │     │  └─ oned_feature_extractor_mobile.tflite
│  │  │  │  │  │     ├─ native-bridge.js
│  │  │  │  │  │     └─ public
│  │  │  │  │  │        ├─ assets
│  │  │  │  │  │        │  ├─ bch-C7lBzaT0.png
│  │  │  │  │  │        │  ├─ ic_launcher-66abd8b866bfb
│  │  │  │  │  │        │  │  ├─ android
│  │  │  │  │  │        │  │  │  ├─ ic_launcher-web.png
│  │  │  │  │  │        │  │  │  ├─ mipmap-anydpi-v26
│  │  │  │  │  │        │  │  │  │  ├─ ic_launcher.xml
│  │  │  │  │  │        │  │  │  │  └─ ic_launcher_round.xml
│  │  │  │  │  │        │  │  │  ├─ mipmap-hdpi
│  │  │  │  │  │        │  │  │  │  ├─ ic_launcher.png
│  │  │  │  │  │        │  │  │  │  ├─ ic_launcher_foreground.png
│  │  │  │  │  │        │  │  │  │  └─ ic_launcher_round.png
│  │  │  │  │  │        │  │  │  ├─ mipmap-ldpi
│  │  │  │  │  │        │  │  │  │  └─ ic_launcher.png
│  │  │  │  │  │        │  │  │  ├─ mipmap-mdpi
│  │  │  │  │  │        │  │  │  │  ├─ ic_launcher.png
│  │  │  │  │  │        │  │  │  │  ├─ ic_launcher_foreground.png
│  │  │  │  │  │        │  │  │  │  └─ ic_launcher_round.png
│  │  │  │  │  │        │  │  │  ├─ mipmap-xhdpi
│  │  │  │  │  │        │  │  │  │  ├─ ic_launcher.png
│  │  │  │  │  │        │  │  │  │  ├─ ic_launcher_foreground.png
│  │  │  │  │  │        │  │  │  │  └─ ic_launcher_round.png
│  │  │  │  │  │        │  │  │  ├─ mipmap-xxhdpi
│  │  │  │  │  │        │  │  │  │  ├─ ic_launcher.png
│  │  │  │  │  │        │  │  │  │  ├─ ic_launcher_foreground.png
│  │  │  │  │  │        │  │  │  │  └─ ic_launcher_round.png
│  │  │  │  │  │        │  │  │  ├─ mipmap-xxxhdpi
│  │  │  │  │  │        │  │  │  │  ├─ ic_launcher.png
│  │  │  │  │  │        │  │  │  │  ├─ ic_launcher_foreground.png
│  │  │  │  │  │        │  │  │  │  └─ ic_launcher_round.png
│  │  │  │  │  │        │  │  │  ├─ playstore-icon.png
│  │  │  │  │  │        │  │  │  └─ values
│  │  │  │  │  │        │  │  │     └─ ic_launcher_background.xml
│  │  │  │  │  │        │  │  └─ ios
│  │  │  │  │  │        │  │     ├─ AppIcon.appiconset
│  │  │  │  │  │        │  │     │  ├─ Contents.json
│  │  │  │  │  │        │  │     │  ├─ Icon-App-20x20@1x.png
│  │  │  │  │  │        │  │     │  ├─ Icon-App-20x20@2x.png
│  │  │  │  │  │        │  │     │  ├─ Icon-App-20x20@3x.png
│  │  │  │  │  │        │  │     │  ├─ Icon-App-29x29@1x.png
│  │  │  │  │  │        │  │     │  ├─ Icon-App-29x29@2x.png
│  │  │  │  │  │        │  │     │  ├─ Icon-App-29x29@3x.png
│  │  │  │  │  │        │  │     │  ├─ Icon-App-40x40@1x.png
│  │  │  │  │  │        │  │     │  ├─ Icon-App-40x40@2x.png
│  │  │  │  │  │        │  │     │  ├─ Icon-App-40x40@3x.png
│  │  │  │  │  │        │  │     │  ├─ Icon-App-60x60@2x.png
│  │  │  │  │  │        │  │     │  ├─ Icon-App-60x60@3x.png
│  │  │  │  │  │        │  │     │  ├─ Icon-App-76x76@1x.png
│  │  │  │  │  │        │  │     │  ├─ Icon-App-76x76@2x.png
│  │  │  │  │  │        │  │     │  ├─ Icon-App-83.5x83.5@2x.png
│  │  │  │  │  │        │  │     │  └─ ItunesArtwork@2x.png
│  │  │  │  │  │        │  │     ├─ iTunesArtwork@1x.png
│  │  │  │  │  │        │  │     ├─ iTunesArtwork@2x.png
│  │  │  │  │  │        │  │     └─ iTunesArtwork@3x.png
│  │  │  │  │  │        │  ├─ images
│  │  │  │  │  │        │  │  ├─ EnterIcon1.png
│  │  │  │  │  │        │  │  ├─ EnterIcon2.png
│  │  │  │  │  │        │  │  ├─ Faucet.png
│  │  │  │  │  │        │  │  ├─ OPTNUIkeyline.png
│  │  │  │  │  │        │  │  ├─ OPTNUIkeyline2.png
│  │  │  │  │  │        │  │  ├─ OPTNWelcome1.png
│  │  │  │  │  │        │  │  ├─ OPTNWelcome2.png
│  │  │  │  │  │        │  │  ├─ OPTNWelcome3.png
│  │  │  │  │  │        │  │  └─ fundme.png
│  │  │  │  │  │        │  ├─ index-CREajJkM.js
│  │  │  │  │  │        │  ├─ index-CREajJkM.js.map
│  │  │  │  │  │        │  ├─ index-catUKt9N.css
│  │  │  │  │  │        │  ├─ index-wTwDO9zr.js
│  │  │  │  │  │        │  ├─ index-wTwDO9zr.js.map
│  │  │  │  │  │        │  ├─ revicons-BNIKeAUC.eot
│  │  │  │  │  │        │  ├─ revicons-CBqxZnew.ttf
│  │  │  │  │  │        │  ├─ revicons-DbTteTvA.woff
│  │  │  │  │  │        │  ├─ secp256k1-DAIEGPPj.js
│  │  │  │  │  │        │  ├─ secp256k1-DAIEGPPj.js.map
│  │  │  │  │  │        │  ├─ sql-wasm-hQY6UH0C.js
│  │  │  │  │  │        │  ├─ sql-wasm-hQY6UH0C.js.map
│  │  │  │  │  │        │  ├─ web-8-uMadbu.js
│  │  │  │  │  │        │  ├─ web-8-uMadbu.js.map
│  │  │  │  │  │        │  ├─ web-B6XdMQxJ.js
│  │  │  │  │  │        │  ├─ web-B6XdMQxJ.js.map
│  │  │  │  │  │        │  ├─ web-Cxoq0Gsc.js
│  │  │  │  │  │        │  ├─ web-Cxoq0Gsc.js.map
│  │  │  │  │  │        │  ├─ web-gbyWvC71.js
│  │  │  │  │  │        │  └─ web-gbyWvC71.js.map
│  │  │  │  │  │        ├─ cordova.js
│  │  │  │  │  │        ├─ cordova_plugins.js
│  │  │  │  │  │        ├─ index.html
│  │  │  │  │  │        └─ sql-wasm.wasm
│  │  │  │  │  └─ release
│  │  │  │  │     └─ mergeReleaseAssets
│  │  │  │  │        ├─ capacitor.config.json
│  │  │  │  │        ├─ capacitor.plugins.json
│  │  │  │  │        ├─ mlkit_barcode_models
│  │  │  │  │        │  ├─ barcode_ssd_mobilenet_v1_dmp25_quant.tflite
│  │  │  │  │        │  ├─ oned_auto_regressor_mobile.tflite
│  │  │  │  │        │  └─ oned_feature_extractor_mobile.tflite
│  │  │  │  │        ├─ native-bridge.js
│  │  │  │  │        └─ public
│  │  │  │  │           ├─ assets
│  │  │  │  │           │  ├─ bch-C7lBzaT0.png
│  │  │  │  │           │  ├─ ic_launcher-66abd8b866bfb
│  │  │  │  │           │  │  ├─ android
│  │  │  │  │           │  │  │  ├─ ic_launcher-web.png
│  │  │  │  │           │  │  │  ├─ mipmap-anydpi-v26
│  │  │  │  │           │  │  │  │  ├─ ic_launcher.xml
│  │  │  │  │           │  │  │  │  └─ ic_launcher_round.xml
│  │  │  │  │           │  │  │  ├─ mipmap-hdpi
│  │  │  │  │           │  │  │  │  ├─ ic_launcher.png
│  │  │  │  │           │  │  │  │  ├─ ic_launcher_foreground.png
│  │  │  │  │           │  │  │  │  └─ ic_launcher_round.png
│  │  │  │  │           │  │  │  ├─ mipmap-ldpi
│  │  │  │  │           │  │  │  │  └─ ic_launcher.png
│  │  │  │  │           │  │  │  ├─ mipmap-mdpi
│  │  │  │  │           │  │  │  │  ├─ ic_launcher.png
│  │  │  │  │           │  │  │  │  ├─ ic_launcher_foreground.png
│  │  │  │  │           │  │  │  │  └─ ic_launcher_round.png
│  │  │  │  │           │  │  │  ├─ mipmap-xhdpi
│  │  │  │  │           │  │  │  │  ├─ ic_launcher.png
│  │  │  │  │           │  │  │  │  ├─ ic_launcher_foreground.png
│  │  │  │  │           │  │  │  │  └─ ic_launcher_round.png
│  │  │  │  │           │  │  │  ├─ mipmap-xxhdpi
│  │  │  │  │           │  │  │  │  ├─ ic_launcher.png
│  │  │  │  │           │  │  │  │  ├─ ic_launcher_foreground.png
│  │  │  │  │           │  │  │  │  └─ ic_launcher_round.png
│  │  │  │  │           │  │  │  ├─ mipmap-xxxhdpi
│  │  │  │  │           │  │  │  │  ├─ ic_launcher.png
│  │  │  │  │           │  │  │  │  ├─ ic_launcher_foreground.png
│  │  │  │  │           │  │  │  │  └─ ic_launcher_round.png
│  │  │  │  │           │  │  │  ├─ playstore-icon.png
│  │  │  │  │           │  │  │  └─ values
│  │  │  │  │           │  │  │     └─ ic_launcher_background.xml
│  │  │  │  │           │  │  └─ ios
│  │  │  │  │           │  │     ├─ AppIcon.appiconset
│  │  │  │  │           │  │     │  ├─ Contents.json
│  │  │  │  │           │  │     │  ├─ Icon-App-20x20@1x.png
│  │  │  │  │           │  │     │  ├─ Icon-App-20x20@2x.png
│  │  │  │  │           │  │     │  ├─ Icon-App-20x20@3x.png
│  │  │  │  │           │  │     │  ├─ Icon-App-29x29@1x.png
│  │  │  │  │           │  │     │  ├─ Icon-App-29x29@2x.png
│  │  │  │  │           │  │     │  ├─ Icon-App-29x29@3x.png
│  │  │  │  │           │  │     │  ├─ Icon-App-40x40@1x.png
│  │  │  │  │           │  │     │  ├─ Icon-App-40x40@2x.png
│  │  │  │  │           │  │     │  ├─ Icon-App-40x40@3x.png
│  │  │  │  │           │  │     │  ├─ Icon-App-60x60@2x.png
│  │  │  │  │           │  │     │  ├─ Icon-App-60x60@3x.png
│  │  │  │  │           │  │     │  ├─ Icon-App-76x76@1x.png
│  │  │  │  │           │  │     │  ├─ Icon-App-76x76@2x.png
│  │  │  │  │           │  │     │  ├─ Icon-App-83.5x83.5@2x.png
│  │  │  │  │           │  │     │  └─ ItunesArtwork@2x.png
│  │  │  │  │           │  │     ├─ iTunesArtwork@1x.png
│  │  │  │  │           │  │     ├─ iTunesArtwork@2x.png
│  │  │  │  │           │  │     └─ iTunesArtwork@3x.png
│  │  │  │  │           │  ├─ images
│  │  │  │  │           │  │  ├─ EnterIcon1.png
│  │  │  │  │           │  │  ├─ EnterIcon2.png
│  │  │  │  │           │  │  ├─ Faucet.png
│  │  │  │  │           │  │  ├─ OPTNUIkeyline.png
│  │  │  │  │           │  │  ├─ OPTNUIkeyline2.png
│  │  │  │  │           │  │  ├─ OPTNWelcome1.png
│  │  │  │  │           │  │  ├─ OPTNWelcome2.png
│  │  │  │  │           │  │  ├─ OPTNWelcome3.png
│  │  │  │  │           │  │  └─ fundme.png
│  │  │  │  │           │  ├─ index-Bzr210uQ.js
│  │  │  │  │           │  ├─ index-Bzr210uQ.js.map
│  │  │  │  │           │  ├─ index-GabcIChG.js
│  │  │  │  │           │  ├─ index-GabcIChG.js.map
│  │  │  │  │           │  ├─ index-lZkr9sxV.css
│  │  │  │  │           │  ├─ revicons-BNIKeAUC.eot
│  │  │  │  │           │  ├─ revicons-CBqxZnew.ttf
│  │  │  │  │           │  ├─ revicons-DbTteTvA.woff
│  │  │  │  │           │  ├─ secp256k1-BYAPkVKM.js
│  │  │  │  │           │  ├─ secp256k1-BYAPkVKM.js.map
│  │  │  │  │           │  ├─ sql-wasm-hQY6UH0C.js
│  │  │  │  │           │  ├─ sql-wasm-hQY6UH0C.js.map
│  │  │  │  │           │  ├─ web-C5xNDOy2.js
│  │  │  │  │           │  ├─ web-C5xNDOy2.js.map
│  │  │  │  │           │  ├─ web-CjR9Nrxv.js
│  │  │  │  │           │  ├─ web-CjR9Nrxv.js.map
│  │  │  │  │           │  ├─ web-DuJE7k0E.js
│  │  │  │  │           │  ├─ web-DuJE7k0E.js.map
│  │  │  │  │           │  ├─ web-otYMzpOj.js
│  │  │  │  │           │  └─ web-otYMzpOj.js.map
│  │  │  │  │           ├─ cordova.js
│  │  │  │  │           ├─ cordova_plugins.js
│  │  │  │  │           ├─ index.html
│  │  │  │  │           └─ sql-wasm.wasm
│  │  │  │  ├─ binary_art_profile
│  │  │  │  │  └─ release
│  │  │  │  │     └─ compileReleaseArtProfile
│  │  │  │  │        └─ baseline.prof
│  │  │  │  ├─ binary_art_profile_metadata
│  │  │  │  │  └─ release
│  │  │  │  │     └─ compileReleaseArtProfile
│  │  │  │  │        └─ baseline.profm
│  │  │  │  ├─ bundle_dependency_report
│  │  │  │  │  └─ release
│  │  │  │  │     └─ configureReleaseDependencies
│  │  │  │  │        └─ dependencies.pb
│  │  │  │  ├─ bundle_ide_model
│  │  │  │  │  └─ release
│  │  │  │  │     └─ produceReleaseBundleIdeListingFile
│  │  │  │  │        └─ output-metadata.json
│  │  │  │  ├─ bundle_ide_redirect_file
│  │  │  │  │  └─ release
│  │  │  │  │     └─ createReleaseBundleListingFileRedirect
│  │  │  │  │        └─ redirect.txt
│  │  │  │  ├─ bundle_manifest
│  │  │  │  │  └─ release
│  │  │  │  │     └─ processApplicationManifestReleaseForBundle
│  │  │  │  │        └─ AndroidManifest.xml
│  │  │  │  ├─ combined_art_profile
│  │  │  │  │  └─ release
│  │  │  │  │     └─ compileReleaseArtProfile
│  │  │  │  │        └─ baseline-prof.txt
│  │  │  │  ├─ compatible_screen_manifest
│  │  │  │  │  ├─ debug
│  │  │  │  │  │  └─ createDebugCompatibleScreenManifests
│  │  │  │  │  │     └─ output-metadata.json
│  │  │  │  │  └─ release
│  │  │  │  │     └─ createReleaseCompatibleScreenManifests
│  │  │  │  │        └─ output-metadata.json
│  │  │  │  ├─ compile_and_runtime_not_namespaced_r_class_jar
│  │  │  │  │  ├─ debug
│  │  │  │  │  │  └─ processDebugResources
│  │  │  │  │  │     └─ R.jar
│  │  │  │  │  └─ release
│  │  │  │  │     └─ processReleaseResources
│  │  │  │  │        └─ R.jar
│  │  │  │  ├─ compressed_assets
│  │  │  │  │  ├─ debug
│  │  │  │  │  │  └─ compressDebugAssets
│  │  │  │  │  │     └─ out
│  │  │  │  │  │        └─ assets
│  │  │  │  │  │           ├─ capacitor.config.json.jar
│  │  │  │  │  │           ├─ capacitor.plugins.json.jar
│  │  │  │  │  │           ├─ mlkit_barcode_models
│  │  │  │  │  │           │  ├─ barcode_ssd_mobilenet_v1_dmp25_quant.tflite.jar
│  │  │  │  │  │           │  ├─ oned_auto_regressor_mobile.tflite.jar
│  │  │  │  │  │           │  └─ oned_feature_extractor_mobile.tflite.jar
│  │  │  │  │  │           ├─ native-bridge.js.jar
│  │  │  │  │  │           └─ public
│  │  │  │  │  │              ├─ assets
│  │  │  │  │  │              │  ├─ bch-C7lBzaT0.png.jar
│  │  │  │  │  │              │  ├─ ic_launcher-66abd8b866bfb
│  │  │  │  │  │              │  │  ├─ android
│  │  │  │  │  │              │  │  │  ├─ ic_launcher-web.png.jar
│  │  │  │  │  │              │  │  │  ├─ mipmap-anydpi-v26
│  │  │  │  │  │              │  │  │  │  ├─ ic_launcher.xml.jar
│  │  │  │  │  │              │  │  │  │  └─ ic_launcher_round.xml.jar
│  │  │  │  │  │              │  │  │  ├─ mipmap-hdpi
│  │  │  │  │  │              │  │  │  │  ├─ ic_launcher.png.jar
│  │  │  │  │  │              │  │  │  │  ├─ ic_launcher_foreground.png.jar
│  │  │  │  │  │              │  │  │  │  └─ ic_launcher_round.png.jar
│  │  │  │  │  │              │  │  │  ├─ mipmap-ldpi
│  │  │  │  │  │              │  │  │  │  └─ ic_launcher.png.jar
│  │  │  │  │  │              │  │  │  ├─ mipmap-mdpi
│  │  │  │  │  │              │  │  │  │  ├─ ic_launcher.png.jar
│  │  │  │  │  │              │  │  │  │  ├─ ic_launcher_foreground.png.jar
│  │  │  │  │  │              │  │  │  │  └─ ic_launcher_round.png.jar
│  │  │  │  │  │              │  │  │  ├─ mipmap-xhdpi
│  │  │  │  │  │              │  │  │  │  ├─ ic_launcher.png.jar
│  │  │  │  │  │              │  │  │  │  ├─ ic_launcher_foreground.png.jar
│  │  │  │  │  │              │  │  │  │  └─ ic_launcher_round.png.jar
│  │  │  │  │  │              │  │  │  ├─ mipmap-xxhdpi
│  │  │  │  │  │              │  │  │  │  ├─ ic_launcher.png.jar
│  │  │  │  │  │              │  │  │  │  ├─ ic_launcher_foreground.png.jar
│  │  │  │  │  │              │  │  │  │  └─ ic_launcher_round.png.jar
│  │  │  │  │  │              │  │  │  ├─ mipmap-xxxhdpi
│  │  │  │  │  │              │  │  │  │  ├─ ic_launcher.png.jar
│  │  │  │  │  │              │  │  │  │  ├─ ic_launcher_foreground.png.jar
│  │  │  │  │  │              │  │  │  │  └─ ic_launcher_round.png.jar
│  │  │  │  │  │              │  │  │  ├─ playstore-icon.png.jar
│  │  │  │  │  │              │  │  │  └─ values
│  │  │  │  │  │              │  │  │     └─ ic_launcher_background.xml.jar
│  │  │  │  │  │              │  │  └─ ios
│  │  │  │  │  │              │  │     ├─ AppIcon.appiconset
│  │  │  │  │  │              │  │     │  ├─ Contents.json.jar
│  │  │  │  │  │              │  │     │  ├─ Icon-App-20x20@1x.png.jar
│  │  │  │  │  │              │  │     │  ├─ Icon-App-20x20@2x.png.jar
│  │  │  │  │  │              │  │     │  ├─ Icon-App-20x20@3x.png.jar
│  │  │  │  │  │              │  │     │  ├─ Icon-App-29x29@1x.png.jar
│  │  │  │  │  │              │  │     │  ├─ Icon-App-29x29@2x.png.jar
│  │  │  │  │  │              │  │     │  ├─ Icon-App-29x29@3x.png.jar
│  │  │  │  │  │              │  │     │  ├─ Icon-App-40x40@1x.png.jar
│  │  │  │  │  │              │  │     │  ├─ Icon-App-40x40@2x.png.jar
│  │  │  │  │  │              │  │     │  ├─ Icon-App-40x40@3x.png.jar
│  │  │  │  │  │              │  │     │  ├─ Icon-App-60x60@2x.png.jar
│  │  │  │  │  │              │  │     │  ├─ Icon-App-60x60@3x.png.jar
│  │  │  │  │  │              │  │     │  ├─ Icon-App-76x76@1x.png.jar
│  │  │  │  │  │              │  │     │  ├─ Icon-App-76x76@2x.png.jar
│  │  │  │  │  │              │  │     │  ├─ Icon-App-83.5x83.5@2x.png.jar
│  │  │  │  │  │              │  │     │  └─ ItunesArtwork@2x.png.jar
│  │  │  │  │  │              │  │     ├─ iTunesArtwork@1x.png.jar
│  │  │  │  │  │              │  │     ├─ iTunesArtwork@2x.png.jar
│  │  │  │  │  │              │  │     └─ iTunesArtwork@3x.png.jar
│  │  │  │  │  │              │  ├─ images
│  │  │  │  │  │              │  │  ├─ EnterIcon1.png.jar
│  │  │  │  │  │              │  │  ├─ EnterIcon2.png.jar
│  │  │  │  │  │              │  │  ├─ Faucet.png.jar
│  │  │  │  │  │              │  │  ├─ OPTNUIkeyline.png.jar
│  │  │  │  │  │              │  │  ├─ OPTNUIkeyline2.png.jar
│  │  │  │  │  │              │  │  ├─ OPTNWelcome1.png.jar
│  │  │  │  │  │              │  │  ├─ OPTNWelcome2.png.jar
│  │  │  │  │  │              │  │  ├─ OPTNWelcome3.png.jar
│  │  │  │  │  │              │  │  └─ fundme.png.jar
│  │  │  │  │  │              │  ├─ index-CREajJkM.js.jar
│  │  │  │  │  │              │  ├─ index-CREajJkM.js.map.jar
│  │  │  │  │  │              │  ├─ index-catUKt9N.css.jar
│  │  │  │  │  │              │  ├─ index-wTwDO9zr.js.jar
│  │  │  │  │  │              │  ├─ index-wTwDO9zr.js.map.jar
│  │  │  │  │  │              │  ├─ revicons-BNIKeAUC.eot.jar
│  │  │  │  │  │              │  ├─ revicons-CBqxZnew.ttf.jar
│  │  │  │  │  │              │  ├─ revicons-DbTteTvA.woff.jar
│  │  │  │  │  │              │  ├─ secp256k1-DAIEGPPj.js.jar
│  │  │  │  │  │              │  ├─ secp256k1-DAIEGPPj.js.map.jar
│  │  │  │  │  │              │  ├─ sql-wasm-hQY6UH0C.js.jar
│  │  │  │  │  │              │  ├─ sql-wasm-hQY6UH0C.js.map.jar
│  │  │  │  │  │              │  ├─ web-8-uMadbu.js.jar
│  │  │  │  │  │              │  ├─ web-8-uMadbu.js.map.jar
│  │  │  │  │  │              │  ├─ web-B6XdMQxJ.js.jar
│  │  │  │  │  │              │  ├─ web-B6XdMQxJ.js.map.jar
│  │  │  │  │  │              │  ├─ web-Cxoq0Gsc.js.jar
│  │  │  │  │  │              │  ├─ web-Cxoq0Gsc.js.map.jar
│  │  │  │  │  │              │  ├─ web-gbyWvC71.js.jar
│  │  │  │  │  │              │  └─ web-gbyWvC71.js.map.jar
│  │  │  │  │  │              ├─ cordova.js.jar
│  │  │  │  │  │              ├─ cordova_plugins.js.jar
│  │  │  │  │  │              ├─ index.html.jar
│  │  │  │  │  │              └─ sql-wasm.wasm.jar
│  │  │  │  │  └─ release
│  │  │  │  │     └─ compressReleaseAssets
│  │  │  │  │        └─ out
│  │  │  │  │           └─ assets
│  │  │  │  │              ├─ capacitor.config.json.jar
│  │  │  │  │              ├─ capacitor.plugins.json.jar
│  │  │  │  │              ├─ mlkit_barcode_models
│  │  │  │  │              │  ├─ barcode_ssd_mobilenet_v1_dmp25_quant.tflite.jar
│  │  │  │  │              │  ├─ oned_auto_regressor_mobile.tflite.jar
│  │  │  │  │              │  └─ oned_feature_extractor_mobile.tflite.jar
│  │  │  │  │              ├─ native-bridge.js.jar
│  │  │  │  │              └─ public
│  │  │  │  │                 ├─ assets
│  │  │  │  │                 │  ├─ bch-C7lBzaT0.png.jar
│  │  │  │  │                 │  ├─ ic_launcher-66abd8b866bfb
│  │  │  │  │                 │  │  ├─ android
│  │  │  │  │                 │  │  │  ├─ ic_launcher-web.png.jar
│  │  │  │  │                 │  │  │  ├─ mipmap-anydpi-v26
│  │  │  │  │                 │  │  │  │  ├─ ic_launcher.xml.jar
│  │  │  │  │                 │  │  │  │  └─ ic_launcher_round.xml.jar
│  │  │  │  │                 │  │  │  ├─ mipmap-hdpi
│  │  │  │  │                 │  │  │  │  ├─ ic_launcher.png.jar
│  │  │  │  │                 │  │  │  │  ├─ ic_launcher_foreground.png.jar
│  │  │  │  │                 │  │  │  │  └─ ic_launcher_round.png.jar
│  │  │  │  │                 │  │  │  ├─ mipmap-ldpi
│  │  │  │  │                 │  │  │  │  └─ ic_launcher.png.jar
│  │  │  │  │                 │  │  │  ├─ mipmap-mdpi
│  │  │  │  │                 │  │  │  │  ├─ ic_launcher.png.jar
│  │  │  │  │                 │  │  │  │  ├─ ic_launcher_foreground.png.jar
│  │  │  │  │                 │  │  │  │  └─ ic_launcher_round.png.jar
│  │  │  │  │                 │  │  │  ├─ mipmap-xhdpi
│  │  │  │  │                 │  │  │  │  ├─ ic_launcher.png.jar
│  │  │  │  │                 │  │  │  │  ├─ ic_launcher_foreground.png.jar
│  │  │  │  │                 │  │  │  │  └─ ic_launcher_round.png.jar
│  │  │  │  │                 │  │  │  ├─ mipmap-xxhdpi
│  │  │  │  │                 │  │  │  │  ├─ ic_launcher.png.jar
│  │  │  │  │                 │  │  │  │  ├─ ic_launcher_foreground.png.jar
│  │  │  │  │                 │  │  │  │  └─ ic_launcher_round.png.jar
│  │  │  │  │                 │  │  │  ├─ mipmap-xxxhdpi
│  │  │  │  │                 │  │  │  │  ├─ ic_launcher.png.jar
│  │  │  │  │                 │  │  │  │  ├─ ic_launcher_foreground.png.jar
│  │  │  │  │                 │  │  │  │  └─ ic_launcher_round.png.jar
│  │  │  │  │                 │  │  │  ├─ playstore-icon.png.jar
│  │  │  │  │                 │  │  │  └─ values
│  │  │  │  │                 │  │  │     └─ ic_launcher_background.xml.jar
│  │  │  │  │                 │  │  └─ ios
│  │  │  │  │                 │  │     ├─ AppIcon.appiconset
│  │  │  │  │                 │  │     │  ├─ Contents.json.jar
│  │  │  │  │                 │  │     │  ├─ Icon-App-20x20@1x.png.jar
│  │  │  │  │                 │  │     │  ├─ Icon-App-20x20@2x.png.jar
│  │  │  │  │                 │  │     │  ├─ Icon-App-20x20@3x.png.jar
│  │  │  │  │                 │  │     │  ├─ Icon-App-29x29@1x.png.jar
│  │  │  │  │                 │  │     │  ├─ Icon-App-29x29@2x.png.jar
│  │  │  │  │                 │  │     │  ├─ Icon-App-29x29@3x.png.jar
│  │  │  │  │                 │  │     │  ├─ Icon-App-40x40@1x.png.jar
│  │  │  │  │                 │  │     │  ├─ Icon-App-40x40@2x.png.jar
│  │  │  │  │                 │  │     │  ├─ Icon-App-40x40@3x.png.jar
│  │  │  │  │                 │  │     │  ├─ Icon-App-60x60@2x.png.jar
│  │  │  │  │                 │  │     │  ├─ Icon-App-60x60@3x.png.jar
│  │  │  │  │                 │  │     │  ├─ Icon-App-76x76@1x.png.jar
│  │  │  │  │                 │  │     │  ├─ Icon-App-76x76@2x.png.jar
│  │  │  │  │                 │  │     │  ├─ Icon-App-83.5x83.5@2x.png.jar
│  │  │  │  │                 │  │     │  └─ ItunesArtwork@2x.png.jar
│  │  │  │  │                 │  │     ├─ iTunesArtwork@1x.png.jar
│  │  │  │  │                 │  │     ├─ iTunesArtwork@2x.png.jar
│  │  │  │  │                 │  │     └─ iTunesArtwork@3x.png.jar
│  │  │  │  │                 │  ├─ images
│  │  │  │  │                 │  │  ├─ EnterIcon1.png.jar
│  │  │  │  │                 │  │  ├─ EnterIcon2.png.jar
│  │  │  │  │                 │  │  ├─ Faucet.png.jar
│  │  │  │  │                 │  │  ├─ OPTNUIkeyline.png.jar
│  │  │  │  │                 │  │  ├─ OPTNUIkeyline2.png.jar
│  │  │  │  │                 │  │  ├─ OPTNWelcome1.png.jar
│  │  │  │  │                 │  │  ├─ OPTNWelcome2.png.jar
│  │  │  │  │                 │  │  ├─ OPTNWelcome3.png.jar
│  │  │  │  │                 │  │  └─ fundme.png.jar
│  │  │  │  │                 │  ├─ index-CT-exH3G.js.jar
│  │  │  │  │                 │  ├─ index-CT-exH3G.js.map.jar
│  │  │  │  │                 │  ├─ index-CrHvSTls.js.jar
│  │  │  │  │                 │  ├─ index-CrHvSTls.js.map.jar
│  │  │  │  │                 │  ├─ index-DSUJPo6z.css.jar
│  │  │  │  │                 │  ├─ revicons-BNIKeAUC.eot.jar
│  │  │  │  │                 │  ├─ revicons-CBqxZnew.ttf.jar
│  │  │  │  │                 │  ├─ revicons-DbTteTvA.woff.jar
│  │  │  │  │                 │  ├─ secp256k1-Cif7tyHy.js.jar
│  │  │  │  │                 │  ├─ secp256k1-Cif7tyHy.js.map.jar
│  │  │  │  │                 │  ├─ sql-wasm-KD08CoaB.js.jar
│  │  │  │  │                 │  ├─ sql-wasm-KD08CoaB.js.map.jar
│  │  │  │  │                 │  ├─ web-BVF42Qtn.js.jar
│  │  │  │  │                 │  ├─ web-BVF42Qtn.js.map.jar
│  │  │  │  │                 │  ├─ web-By99P6kv.js.jar
│  │  │  │  │                 │  ├─ web-By99P6kv.js.map.jar
│  │  │  │  │                 │  ├─ web-C9m0q5ME.js.jar
│  │  │  │  │                 │  └─ web-C9m0q5ME.js.map.jar
│  │  │  │  │                 ├─ cordova.js.jar
│  │  │  │  │                 ├─ cordova_plugins.js.jar
│  │  │  │  │                 ├─ index.html.jar
│  │  │  │  │                 └─ sql-wasm.wasm.jar
│  │  │  │  ├─ data_binding_layout_info_type_merge
│  │  │  │  │  ├─ debug
│  │  │  │  │  │  └─ mergeDebugResources
│  │  │  │  │  │     └─ out
│  │  │  │  │  └─ release
│  │  │  │  │     └─ mergeReleaseResources
│  │  │  │  │        └─ out
│  │  │  │  ├─ data_binding_layout_info_type_package
│  │  │  │  │  ├─ debug
│  │  │  │  │  │  └─ packageDebugResources
│  │  │  │  │  │     └─ out
│  │  │  │  │  └─ release
│  │  │  │  │     └─ packageReleaseResources
│  │  │  │  │        └─ out
│  │  │  │  ├─ default_proguard_files
│  │  │  │  │  └─ global
│  │  │  │  │     ├─ proguard-android-optimize.txt-8.7.2
│  │  │  │  │     ├─ proguard-android.txt-8.7.2
│  │  │  │  │     └─ proguard-defaults.txt-8.7.2
│  │  │  │  ├─ desugar_graph
│  │  │  │  │  ├─ debug
│  │  │  │  │  │  └─ dexBuilderDebug
│  │  │  │  │  │     └─ out
│  │  │  │  │  │        ├─ currentProject
│  │  │  │  │  │        │  ├─ dirs_bucket_0
│  │  │  │  │  │        │  │  └─ graph.bin
│  │  │  │  │  │        │  ├─ dirs_bucket_1
│  │  │  │  │  │        │  │  └─ graph.bin
│  │  │  │  │  │        │  ├─ dirs_bucket_2
│  │  │  │  │  │        │  │  └─ graph.bin
│  │  │  │  │  │        │  ├─ jar_3bf8b17c5a0c47f7ab845fbe257379951e49ddcbbea76e02a92fb867b97cbf8e_bucket_0
│  │  │  │  │  │        │  │  └─ graph.bin
│  │  │  │  │  │        │  ├─ jar_3bf8b17c5a0c47f7ab845fbe257379951e49ddcbbea76e02a92fb867b97cbf8e_bucket_1
│  │  │  │  │  │        │  │  └─ graph.bin
│  │  │  │  │  │        │  └─ jar_3bf8b17c5a0c47f7ab845fbe257379951e49ddcbbea76e02a92fb867b97cbf8e_bucket_2
│  │  │  │  │  │        │     └─ graph.bin
│  │  │  │  │  │        ├─ externalLibs
│  │  │  │  │  │        ├─ mixedScopes
│  │  │  │  │  │        └─ otherProjects
│  │  │  │  │  └─ release
│  │  │  │  │     └─ dexBuilderRelease
│  │  │  │  │        └─ out
│  │  │  │  │           ├─ currentProject
│  │  │  │  │           │  ├─ dirs_bucket_0
│  │  │  │  │           │  │  └─ graph.bin
│  │  │  │  │           │  ├─ dirs_bucket_1
│  │  │  │  │           │  │  └─ graph.bin
│  │  │  │  │           │  ├─ dirs_bucket_2
│  │  │  │  │           │  │  └─ graph.bin
│  │  │  │  │           │  ├─ jar_ce04aa2b117ba60c031176d6ffcad9d57fb06f525f989a934f5053d1ffa93ea0_bucket_0
│  │  │  │  │           │  │  └─ graph.bin
│  │  │  │  │           │  ├─ jar_ce04aa2b117ba60c031176d6ffcad9d57fb06f525f989a934f5053d1ffa93ea0_bucket_1
│  │  │  │  │           │  │  └─ graph.bin
│  │  │  │  │           │  └─ jar_ce04aa2b117ba60c031176d6ffcad9d57fb06f525f989a934f5053d1ffa93ea0_bucket_2
│  │  │  │  │           │     └─ graph.bin
│  │  │  │  │           ├─ externalLibs
│  │  │  │  │           ├─ mixedScopes
│  │  │  │  │           └─ otherProjects
│  │  │  │  ├─ dex
│  │  │  │  │  ├─ debug
│  │  │  │  │  │  ├─ mergeExtDexDebug
│  │  │  │  │  │  │  ├─ classes.dex
│  │  │  │  │  │  │  ├─ classes2.dex
│  │  │  │  │  │  │  └─ classes3.dex
│  │  │  │  │  │  ├─ mergeLibDexDebug
│  │  │  │  │  │  │  ├─ 0
│  │  │  │  │  │  │  ├─ 1
│  │  │  │  │  │  │  │  └─ classes.dex
│  │  │  │  │  │  │  ├─ 10
│  │  │  │  │  │  │  ├─ 11
│  │  │  │  │  │  │  ├─ 12
│  │  │  │  │  │  │  │  └─ classes.dex
│  │  │  │  │  │  │  ├─ 13
│  │  │  │  │  │  │  │  └─ classes.dex
│  │  │  │  │  │  │  ├─ 14
│  │  │  │  │  │  │  ├─ 15
│  │  │  │  │  │  │  │  └─ classes.dex
│  │  │  │  │  │  │  ├─ 2
│  │  │  │  │  │  │  │  └─ classes.dex
│  │  │  │  │  │  │  ├─ 3
│  │  │  │  │  │  │  ├─ 4
│  │  │  │  │  │  │  ├─ 5
│  │  │  │  │  │  │  │  └─ classes.dex
│  │  │  │  │  │  │  ├─ 6
│  │  │  │  │  │  │  ├─ 7
│  │  │  │  │  │  │  │  └─ classes.dex
│  │  │  │  │  │  │  ├─ 8
│  │  │  │  │  │  │  │  └─ classes.dex
│  │  │  │  │  │  │  └─ 9
│  │  │  │  │  │  │     └─ classes.dex
│  │  │  │  │  │  └─ mergeProjectDexDebug
│  │  │  │  │  │     ├─ 0
│  │  │  │  │  │     │  └─ classes.dex
│  │  │  │  │  │     ├─ 1
│  │  │  │  │  │     ├─ 10
│  │  │  │  │  │     ├─ 11
│  │  │  │  │  │     ├─ 12
│  │  │  │  │  │     ├─ 13
│  │  │  │  │  │     ├─ 14
│  │  │  │  │  │     ├─ 15
│  │  │  │  │  │     ├─ 2
│  │  │  │  │  │     ├─ 3
│  │  │  │  │  │     ├─ 4
│  │  │  │  │  │     ├─ 5
│  │  │  │  │  │     │  └─ classes.dex
│  │  │  │  │  │     ├─ 6
│  │  │  │  │  │     ├─ 7
│  │  │  │  │  │     ├─ 8
│  │  │  │  │  │     └─ 9
│  │  │  │  │  └─ release
│  │  │  │  │     └─ mergeDexRelease
│  │  │  │  │        ├─ classes.dex
│  │  │  │  │        ├─ classes2.dex
│  │  │  │  │        └─ classes3.dex
│  │  │  │  ├─ dex_archive_input_jar_hashes
│  │  │  │  │  ├─ debug
│  │  │  │  │  │  └─ dexBuilderDebug
│  │  │  │  │  │     └─ out
│  │  │  │  │  └─ release
│  │  │  │  │     └─ dexBuilderRelease
│  │  │  │  │        └─ out
│  │  │  │  ├─ dex_metadata_directory
│  │  │  │  │  └─ release
│  │  │  │  │     └─ compileReleaseArtProfile
│  │  │  │  │        ├─ 0
│  │  │  │  │        │  └─ .dm
│  │  │  │  │        ├─ 1
│  │  │  │  │        │  └─ .dm
│  │  │  │  │        └─ dex-metadata-map.properties
│  │  │  │  ├─ dex_number_of_buckets_file
│  │  │  │  │  ├─ debug
│  │  │  │  │  │  └─ dexBuilderDebug
│  │  │  │  │  │     └─ out
│  │  │  │  │  └─ release
│  │  │  │  │     └─ dexBuilderRelease
│  │  │  │  │        └─ out
│  │  │  │  ├─ duplicate_classes_check
│  │  │  │  │  ├─ debug
│  │  │  │  │  │  └─ checkDebugDuplicateClasses
│  │  │  │  │  └─ release
│  │  │  │  │     └─ checkReleaseDuplicateClasses
│  │  │  │  ├─ external_file_lib_dex_archives
│  │  │  │  │  ├─ debug
│  │  │  │  │  │  └─ desugarDebugFileDependencies
│  │  │  │  │  └─ release
│  │  │  │  │     └─ desugarReleaseFileDependencies
│  │  │  │  ├─ external_libs_dex
│  │  │  │  │  └─ release
│  │  │  │  │     └─ mergeExtDexRelease
│  │  │  │  │        ├─ classes.dex
│  │  │  │  │        ├─ classes2.dex
│  │  │  │  │        └─ classes3.dex
│  │  │  │  ├─ external_libs_dex_archive
│  │  │  │  │  ├─ debug
│  │  │  │  │  │  └─ dexBuilderDebug
│  │  │  │  │  │     └─ out
│  │  │  │  │  └─ release
│  │  │  │  │     └─ dexBuilderRelease
│  │  │  │  │        └─ out
│  │  │  │  ├─ external_libs_dex_archive_with_artifact_transforms
│  │  │  │  │  ├─ debug
│  │  │  │  │  │  └─ dexBuilderDebug
│  │  │  │  │  │     └─ out
│  │  │  │  │  └─ release
│  │  │  │  │     └─ dexBuilderRelease
│  │  │  │  │        └─ out
│  │  │  │  ├─ global_synthetics_dex
│  │  │  │  │  ├─ debug
│  │  │  │  │  │  └─ mergeDebugGlobalSynthetics
│  │  │  │  │  └─ release
│  │  │  │  │     └─ mergeReleaseGlobalSynthetics
│  │  │  │  ├─ global_synthetics_external_lib
│  │  │  │  │  ├─ debug
│  │  │  │  │  │  └─ dexBuilderDebug
│  │  │  │  │  │     └─ out
│  │  │  │  │  └─ release
│  │  │  │  │     └─ dexBuilderRelease
│  │  │  │  │        └─ out
│  │  │  │  ├─ global_synthetics_external_libs_artifact_transform
│  │  │  │  │  ├─ debug
│  │  │  │  │  │  └─ dexBuilderDebug
│  │  │  │  │  │     └─ out
│  │  │  │  │  └─ release
│  │  │  │  │     └─ dexBuilderRelease
│  │  │  │  │        └─ out
│  │  │  │  ├─ global_synthetics_file_lib
│  │  │  │  │  ├─ debug
│  │  │  │  │  │  └─ desugarDebugFileDependencies
│  │  │  │  │  └─ release
│  │  │  │  │     └─ desugarReleaseFileDependencies
│  │  │  │  ├─ global_synthetics_mixed_scope
│  │  │  │  │  ├─ debug
│  │  │  │  │  │  └─ dexBuilderDebug
│  │  │  │  │  │     └─ out
│  │  │  │  │  └─ release
│  │  │  │  │     └─ dexBuilderRelease
│  │  │  │  │        └─ out
│  │  │  │  ├─ global_synthetics_project
│  │  │  │  │  ├─ debug
│  │  │  │  │  │  └─ dexBuilderDebug
│  │  │  │  │  │     └─ out
│  │  │  │  │  └─ release
│  │  │  │  │     └─ dexBuilderRelease
│  │  │  │  │        └─ out
│  │  │  │  ├─ global_synthetics_subproject
│  │  │  │  │  ├─ debug
│  │  │  │  │  │  └─ dexBuilderDebug
│  │  │  │  │  │     └─ out
│  │  │  │  │  └─ release
│  │  │  │  │     └─ dexBuilderRelease
│  │  │  │  │        └─ out
│  │  │  │  ├─ incremental
│  │  │  │  │  ├─ bundleReleaseResources
│  │  │  │  │  ├─ debug
│  │  │  │  │  │  ├─ mergeDebugResources
│  │  │  │  │  │  │  ├─ compile-file-map.properties
│  │  │  │  │  │  │  ├─ merged.dir
│  │  │  │  │  │  │  │  ├─ values
│  │  │  │  │  │  │  │  │  └─ values.xml
│  │  │  │  │  │  │  │  ├─ values-af
│  │  │  │  │  │  │  │  │  └─ values-af.xml
│  │  │  │  │  │  │  │  ├─ values-am
│  │  │  │  │  │  │  │  │  └─ values-am.xml
│  │  │  │  │  │  │  │  ├─ values-ar
│  │  │  │  │  │  │  │  │  └─ values-ar.xml
│  │  │  │  │  │  │  │  ├─ values-as
│  │  │  │  │  │  │  │  │  └─ values-as.xml
│  │  │  │  │  │  │  │  ├─ values-az
│  │  │  │  │  │  │  │  │  └─ values-az.xml
│  │  │  │  │  │  │  │  ├─ values-b+es+419
│  │  │  │  │  │  │  │  │  └─ values-b+es+419.xml
│  │  │  │  │  │  │  │  ├─ values-b+sr+Latn
│  │  │  │  │  │  │  │  │  └─ values-b+sr+Latn.xml
│  │  │  │  │  │  │  │  ├─ values-be
│  │  │  │  │  │  │  │  │  └─ values-be.xml
│  │  │  │  │  │  │  │  ├─ values-bg
│  │  │  │  │  │  │  │  │  └─ values-bg.xml
│  │  │  │  │  │  │  │  ├─ values-bn
│  │  │  │  │  │  │  │  │  └─ values-bn.xml
│  │  │  │  │  │  │  │  ├─ values-bs
│  │  │  │  │  │  │  │  │  └─ values-bs.xml
│  │  │  │  │  │  │  │  ├─ values-ca
│  │  │  │  │  │  │  │  │  └─ values-ca.xml
│  │  │  │  │  │  │  │  ├─ values-cs
│  │  │  │  │  │  │  │  │  └─ values-cs.xml
│  │  │  │  │  │  │  │  ├─ values-da
│  │  │  │  │  │  │  │  │  └─ values-da.xml
│  │  │  │  │  │  │  │  ├─ values-de
│  │  │  │  │  │  │  │  │  └─ values-de.xml
│  │  │  │  │  │  │  │  ├─ values-el
│  │  │  │  │  │  │  │  │  └─ values-el.xml
│  │  │  │  │  │  │  │  ├─ values-en-rAU
│  │  │  │  │  │  │  │  │  └─ values-en-rAU.xml
│  │  │  │  │  │  │  │  ├─ values-en-rCA
│  │  │  │  │  │  │  │  │  └─ values-en-rCA.xml
│  │  │  │  │  │  │  │  ├─ values-en-rGB
│  │  │  │  │  │  │  │  │  └─ values-en-rGB.xml
│  │  │  │  │  │  │  │  ├─ values-en-rIN
│  │  │  │  │  │  │  │  │  └─ values-en-rIN.xml
│  │  │  │  │  │  │  │  ├─ values-en-rXC
│  │  │  │  │  │  │  │  │  └─ values-en-rXC.xml
│  │  │  │  │  │  │  │  ├─ values-es
│  │  │  │  │  │  │  │  │  └─ values-es.xml
│  │  │  │  │  │  │  │  ├─ values-es-rUS
│  │  │  │  │  │  │  │  │  └─ values-es-rUS.xml
│  │  │  │  │  │  │  │  ├─ values-et
│  │  │  │  │  │  │  │  │  └─ values-et.xml
│  │  │  │  │  │  │  │  ├─ values-eu
│  │  │  │  │  │  │  │  │  └─ values-eu.xml
│  │  │  │  │  │  │  │  ├─ values-fa
│  │  │  │  │  │  │  │  │  └─ values-fa.xml
│  │  │  │  │  │  │  │  ├─ values-fi
│  │  │  │  │  │  │  │  │  └─ values-fi.xml
│  │  │  │  │  │  │  │  ├─ values-fr
│  │  │  │  │  │  │  │  │  └─ values-fr.xml
│  │  │  │  │  │  │  │  ├─ values-fr-rCA
│  │  │  │  │  │  │  │  │  └─ values-fr-rCA.xml
│  │  │  │  │  │  │  │  ├─ values-gl
│  │  │  │  │  │  │  │  │  └─ values-gl.xml
│  │  │  │  │  │  │  │  ├─ values-gu
│  │  │  │  │  │  │  │  │  └─ values-gu.xml
│  │  │  │  │  │  │  │  ├─ values-h320dp-port-v13
│  │  │  │  │  │  │  │  │  └─ values-h320dp-port-v13.xml
│  │  │  │  │  │  │  │  ├─ values-h360dp-land-v13
│  │  │  │  │  │  │  │  │  └─ values-h360dp-land-v13.xml
│  │  │  │  │  │  │  │  ├─ values-h480dp-land-v13
│  │  │  │  │  │  │  │  │  └─ values-h480dp-land-v13.xml
│  │  │  │  │  │  │  │  ├─ values-h550dp-port-v13
│  │  │  │  │  │  │  │  │  └─ values-h550dp-port-v13.xml
│  │  │  │  │  │  │  │  ├─ values-h720dp-v13
│  │  │  │  │  │  │  │  │  └─ values-h720dp-v13.xml
│  │  │  │  │  │  │  │  ├─ values-hdpi-v4
│  │  │  │  │  │  │  │  │  └─ values-hdpi-v4.xml
│  │  │  │  │  │  │  │  ├─ values-hi
│  │  │  │  │  │  │  │  │  └─ values-hi.xml
│  │  │  │  │  │  │  │  ├─ values-hr
│  │  │  │  │  │  │  │  │  └─ values-hr.xml
│  │  │  │  │  │  │  │  ├─ values-hu
│  │  │  │  │  │  │  │  │  └─ values-hu.xml
│  │  │  │  │  │  │  │  ├─ values-hy
│  │  │  │  │  │  │  │  │  └─ values-hy.xml
│  │  │  │  │  │  │  │  ├─ values-in
│  │  │  │  │  │  │  │  │  └─ values-in.xml
│  │  │  │  │  │  │  │  ├─ values-is
│  │  │  │  │  │  │  │  │  └─ values-is.xml
│  │  │  │  │  │  │  │  ├─ values-it
│  │  │  │  │  │  │  │  │  └─ values-it.xml
│  │  │  │  │  │  │  │  ├─ values-iw
│  │  │  │  │  │  │  │  │  └─ values-iw.xml
│  │  │  │  │  │  │  │  ├─ values-ja
│  │  │  │  │  │  │  │  │  └─ values-ja.xml
│  │  │  │  │  │  │  │  ├─ values-ka
│  │  │  │  │  │  │  │  │  └─ values-ka.xml
│  │  │  │  │  │  │  │  ├─ values-kk
│  │  │  │  │  │  │  │  │  └─ values-kk.xml
│  │  │  │  │  │  │  │  ├─ values-km
│  │  │  │  │  │  │  │  │  └─ values-km.xml
│  │  │  │  │  │  │  │  ├─ values-kn
│  │  │  │  │  │  │  │  │  └─ values-kn.xml
│  │  │  │  │  │  │  │  ├─ values-ko
│  │  │  │  │  │  │  │  │  └─ values-ko.xml
│  │  │  │  │  │  │  │  ├─ values-ky
│  │  │  │  │  │  │  │  │  └─ values-ky.xml
│  │  │  │  │  │  │  │  ├─ values-land
│  │  │  │  │  │  │  │  │  └─ values-land.xml
│  │  │  │  │  │  │  │  ├─ values-large-v4
│  │  │  │  │  │  │  │  │  └─ values-large-v4.xml
│  │  │  │  │  │  │  │  ├─ values-ldltr-v21
│  │  │  │  │  │  │  │  │  └─ values-ldltr-v21.xml
│  │  │  │  │  │  │  │  ├─ values-ldrtl-v17
│  │  │  │  │  │  │  │  │  └─ values-ldrtl-v17.xml
│  │  │  │  │  │  │  │  ├─ values-lo
│  │  │  │  │  │  │  │  │  └─ values-lo.xml
│  │  │  │  │  │  │  │  ├─ values-lt
│  │  │  │  │  │  │  │  │  └─ values-lt.xml
│  │  │  │  │  │  │  │  ├─ values-lv
│  │  │  │  │  │  │  │  │  └─ values-lv.xml
│  │  │  │  │  │  │  │  ├─ values-mk
│  │  │  │  │  │  │  │  │  └─ values-mk.xml
│  │  │  │  │  │  │  │  ├─ values-ml
│  │  │  │  │  │  │  │  │  └─ values-ml.xml
│  │  │  │  │  │  │  │  ├─ values-mn
│  │  │  │  │  │  │  │  │  └─ values-mn.xml
│  │  │  │  │  │  │  │  ├─ values-mr
│  │  │  │  │  │  │  │  │  └─ values-mr.xml
│  │  │  │  │  │  │  │  ├─ values-ms
│  │  │  │  │  │  │  │  │  └─ values-ms.xml
│  │  │  │  │  │  │  │  ├─ values-my
│  │  │  │  │  │  │  │  │  └─ values-my.xml
│  │  │  │  │  │  │  │  ├─ values-nb
│  │  │  │  │  │  │  │  │  └─ values-nb.xml
│  │  │  │  │  │  │  │  ├─ values-ne
│  │  │  │  │  │  │  │  │  └─ values-ne.xml
│  │  │  │  │  │  │  │  ├─ values-night-v8
│  │  │  │  │  │  │  │  │  └─ values-night-v8.xml
│  │  │  │  │  │  │  │  ├─ values-nl
│  │  │  │  │  │  │  │  │  └─ values-nl.xml
│  │  │  │  │  │  │  │  ├─ values-or
│  │  │  │  │  │  │  │  │  └─ values-or.xml
│  │  │  │  │  │  │  │  ├─ values-pa
│  │  │  │  │  │  │  │  │  └─ values-pa.xml
│  │  │  │  │  │  │  │  ├─ values-pl
│  │  │  │  │  │  │  │  │  └─ values-pl.xml
│  │  │  │  │  │  │  │  ├─ values-port
│  │  │  │  │  │  │  │  │  └─ values-port.xml
│  │  │  │  │  │  │  │  ├─ values-pt
│  │  │  │  │  │  │  │  │  └─ values-pt.xml
│  │  │  │  │  │  │  │  ├─ values-pt-rBR
│  │  │  │  │  │  │  │  │  └─ values-pt-rBR.xml
│  │  │  │  │  │  │  │  ├─ values-pt-rPT
│  │  │  │  │  │  │  │  │  └─ values-pt-rPT.xml
│  │  │  │  │  │  │  │  ├─ values-ro
│  │  │  │  │  │  │  │  │  └─ values-ro.xml
│  │  │  │  │  │  │  │  ├─ values-ru
│  │  │  │  │  │  │  │  │  └─ values-ru.xml
│  │  │  │  │  │  │  │  ├─ values-si
│  │  │  │  │  │  │  │  │  └─ values-si.xml
│  │  │  │  │  │  │  │  ├─ values-sk
│  │  │  │  │  │  │  │  │  └─ values-sk.xml
│  │  │  │  │  │  │  │  ├─ values-sl
│  │  │  │  │  │  │  │  │  └─ values-sl.xml
│  │  │  │  │  │  │  │  ├─ values-small-v4
│  │  │  │  │  │  │  │  │  └─ values-small-v4.xml
│  │  │  │  │  │  │  │  ├─ values-sq
│  │  │  │  │  │  │  │  │  └─ values-sq.xml
│  │  │  │  │  │  │  │  ├─ values-sr
│  │  │  │  │  │  │  │  │  └─ values-sr.xml
│  │  │  │  │  │  │  │  ├─ values-sv
│  │  │  │  │  │  │  │  │  └─ values-sv.xml
│  │  │  │  │  │  │  │  ├─ values-sw
│  │  │  │  │  │  │  │  │  └─ values-sw.xml
│  │  │  │  │  │  │  │  ├─ values-sw600dp-v13
│  │  │  │  │  │  │  │  │  └─ values-sw600dp-v13.xml
│  │  │  │  │  │  │  │  ├─ values-ta
│  │  │  │  │  │  │  │  │  └─ values-ta.xml
│  │  │  │  │  │  │  │  ├─ values-te
│  │  │  │  │  │  │  │  │  └─ values-te.xml
│  │  │  │  │  │  │  │  ├─ values-th
│  │  │  │  │  │  │  │  │  └─ values-th.xml
│  │  │  │  │  │  │  │  ├─ values-tl
│  │  │  │  │  │  │  │  │  └─ values-tl.xml
│  │  │  │  │  │  │  │  ├─ values-tr
│  │  │  │  │  │  │  │  │  └─ values-tr.xml
│  │  │  │  │  │  │  │  ├─ values-uk
│  │  │  │  │  │  │  │  │  └─ values-uk.xml
│  │  │  │  │  │  │  │  ├─ values-ur
│  │  │  │  │  │  │  │  │  └─ values-ur.xml
│  │  │  │  │  │  │  │  ├─ values-uz
│  │  │  │  │  │  │  │  │  └─ values-uz.xml
│  │  │  │  │  │  │  │  ├─ values-v16
│  │  │  │  │  │  │  │  │  └─ values-v16.xml
│  │  │  │  │  │  │  │  ├─ values-v17
│  │  │  │  │  │  │  │  │  └─ values-v17.xml
│  │  │  │  │  │  │  │  ├─ values-v18
│  │  │  │  │  │  │  │  │  └─ values-v18.xml
│  │  │  │  │  │  │  │  ├─ values-v21
│  │  │  │  │  │  │  │  │  └─ values-v21.xml
│  │  │  │  │  │  │  │  ├─ values-v22
│  │  │  │  │  │  │  │  │  └─ values-v22.xml
│  │  │  │  │  │  │  │  ├─ values-v23
│  │  │  │  │  │  │  │  │  └─ values-v23.xml
│  │  │  │  │  │  │  │  ├─ values-v24
│  │  │  │  │  │  │  │  │  └─ values-v24.xml
│  │  │  │  │  │  │  │  ├─ values-v25
│  │  │  │  │  │  │  │  │  └─ values-v25.xml
│  │  │  │  │  │  │  │  ├─ values-v26
│  │  │  │  │  │  │  │  │  └─ values-v26.xml
│  │  │  │  │  │  │  │  ├─ values-v27
│  │  │  │  │  │  │  │  │  └─ values-v27.xml
│  │  │  │  │  │  │  │  ├─ values-v28
│  │  │  │  │  │  │  │  │  └─ values-v28.xml
│  │  │  │  │  │  │  │  ├─ values-v29
│  │  │  │  │  │  │  │  │  └─ values-v29.xml
│  │  │  │  │  │  │  │  ├─ values-v30
│  │  │  │  │  │  │  │  │  └─ values-v30.xml
│  │  │  │  │  │  │  │  ├─ values-v31
│  │  │  │  │  │  │  │  │  └─ values-v31.xml
│  │  │  │  │  │  │  │  ├─ values-v34
│  │  │  │  │  │  │  │  │  └─ values-v34.xml
│  │  │  │  │  │  │  │  ├─ values-vi
│  │  │  │  │  │  │  │  │  └─ values-vi.xml
│  │  │  │  │  │  │  │  ├─ values-w320dp-land-v13
│  │  │  │  │  │  │  │  │  └─ values-w320dp-land-v13.xml
│  │  │  │  │  │  │  │  ├─ values-w360dp-port-v13
│  │  │  │  │  │  │  │  │  └─ values-w360dp-port-v13.xml
│  │  │  │  │  │  │  │  ├─ values-w400dp-port-v13
│  │  │  │  │  │  │  │  │  └─ values-w400dp-port-v13.xml
│  │  │  │  │  │  │  │  ├─ values-w600dp-land-v13
│  │  │  │  │  │  │  │  │  └─ values-w600dp-land-v13.xml
│  │  │  │  │  │  │  │  ├─ values-watch-v20
│  │  │  │  │  │  │  │  │  └─ values-watch-v20.xml
│  │  │  │  │  │  │  │  ├─ values-watch-v21
│  │  │  │  │  │  │  │  │  └─ values-watch-v21.xml
│  │  │  │  │  │  │  │  ├─ values-xlarge-v4
│  │  │  │  │  │  │  │  │  └─ values-xlarge-v4.xml
│  │  │  │  │  │  │  │  ├─ values-zh-rCN
│  │  │  │  │  │  │  │  │  └─ values-zh-rCN.xml
│  │  │  │  │  │  │  │  ├─ values-zh-rHK
│  │  │  │  │  │  │  │  │  └─ values-zh-rHK.xml
│  │  │  │  │  │  │  │  ├─ values-zh-rTW
│  │  │  │  │  │  │  │  │  └─ values-zh-rTW.xml
│  │  │  │  │  │  │  │  └─ values-zu
│  │  │  │  │  │  │  │     └─ values-zu.xml
│  │  │  │  │  │  │  ├─ merger.xml
│  │  │  │  │  │  │  └─ stripped.dir
│  │  │  │  │  │  └─ packageDebugResources
│  │  │  │  │  │     ├─ compile-file-map.properties
│  │  │  │  │  │     ├─ merged.dir
│  │  │  │  │  │     │  └─ values
│  │  │  │  │  │     │     └─ values.xml
│  │  │  │  │  │     ├─ merger.xml
│  │  │  │  │  │     └─ stripped.dir
│  │  │  │  │  ├─ debug-mergeJavaRes
│  │  │  │  │  │  ├─ merge-state
│  │  │  │  │  │  └─ zip-cache
│  │  │  │  │  │     ├─ +7uvEsvCJvLxfjsUOM4qgqoqFrM=
│  │  │  │  │  │     ├─ 07SPiUxYVmpV2q1khR0LqhRDXzU=
│  │  │  │  │  │     ├─ 0K4ndy1jlu8HuG6GP3XFgZ0ky4Q=
│  │  │  │  │  │     ├─ 2fv5uu0uFpKgQJO0DmMA5ucU0os=
│  │  │  │  │  │     ├─ 3qgaWoc5VFSNxyfQ+XRUDsw7jns=
│  │  │  │  │  │     ├─ 3xRjMvBYHTvsFxpheplTGxqfpVU=
│  │  │  │  │  │     ├─ 4VIbSTsAF9BE6+1Dczq5SMJ5lQ8=
│  │  │  │  │  │     ├─ 5NjURmHlnt9LVMmhDaJZZXA3qeY=
│  │  │  │  │  │     ├─ 5smE6xPwqRgMEJm_EzFv9HD8EEQ=
│  │  │  │  │  │     ├─ 5xJapfvl99HAfn9DUKqtVNbc9r4=
│  │  │  │  │  │     ├─ 65ehIK_E4WvKBN8PRX+suvd1PIg=
│  │  │  │  │  │     ├─ 6YfqiIHDER5Drmw_nr6pgI0RURw=
│  │  │  │  │  │     ├─ 6tNCpKYmWLICLt8VPeintDHNZ3g=
│  │  │  │  │  │     ├─ 784Zz1OsjLqO8v+xld2_74OYjDg=
│  │  │  │  │  │     ├─ 8OmbJWihVtUjs0fG1aqwXW47UCY=
│  │  │  │  │  │     ├─ 8_7kfYUihQsz7BRedVxofsMYH7k=
│  │  │  │  │  │     ├─ 9mffXhdPcPwoAneVCA+WBfst18M=
│  │  │  │  │  │     ├─ 9peWXfV7eiCIwxdj+wVkvnZ5GhI=
│  │  │  │  │  │     ├─ AC91TKcbNXgVKS+pflVIgS4d20k=
│  │  │  │  │  │     ├─ AJO9wZbOsqcNkaSCsagjsO8i79U=
│  │  │  │  │  │     ├─ AtxkoY5KUGR4nsEC314NOE0QaCE=
│  │  │  │  │  │     ├─ BvJb71GCE4AWBJ3r5jQLazBREvo=
│  │  │  │  │  │     ├─ C4v4NXgLepghnSVFoc9w_wu41AQ=
│  │  │  │  │  │     ├─ CUahqEC+J_mNhou7s0SiqxpcUVk=
│  │  │  │  │  │     ├─ Cg7GjBSxHnfhIQ4goA30FTfK_QM=
│  │  │  │  │  │     ├─ CqwN4w0EHaTIYicWDZCi0FVsy4Q=
│  │  │  │  │  │     ├─ DFOaWjghZE4472nkh0jxruboqZU=
│  │  │  │  │  │     ├─ DYMQg0JHYdoOfZ3spy5hDehjSSs=
│  │  │  │  │  │     ├─ Dv+C2bxtie5_hp7A0se5MtnnJPA=
│  │  │  │  │  │     ├─ DxKvWob7RnBsJdlQX82h9OgBtso=
│  │  │  │  │  │     ├─ EXkPiE1lYjfH5nGz1kqDQD6QhzU=
│  │  │  │  │  │     ├─ F+aWsPl92__aCgoDOraz_pty_1A=
│  │  │  │  │  │     ├─ FhYYYM4fX+MkxjYTG_fQWHHmMhY=
│  │  │  │  │  │     ├─ G4yNALmFMEpNZUFV0RTTMdjH3jA=
│  │  │  │  │  │     ├─ GOOPA3HyoWnXQYxizS+YocgADWk=
│  │  │  │  │  │     ├─ HiCPBLtqNEbWSl+ItPj7zYb3RNY=
│  │  │  │  │  │     ├─ HrbXUnAcEXe2x4m5R1I8yQw3OfA=
│  │  │  │  │  │     ├─ Hu65l5MmtlZ7BqVCuwc2B50XOF4=
│  │  │  │  │  │     ├─ I_WxXPsLxktiocR4jwNeWfoZW1c=
│  │  │  │  │  │     ├─ J+uJGcRpsz3uGkovPWMK3wH6Dvg=
│  │  │  │  │  │     ├─ JdGS1Yr9czI7lLnIwcokLdPpmOw=
│  │  │  │  │  │     ├─ Jj3HMouU1pY1o_esxO0au9FBi4Q=
│  │  │  │  │  │     ├─ Kho3g4+W_OdBV3SKCZCRIzYP7Wc=
│  │  │  │  │  │     ├─ NDHOPcqVrt3J5dO8EA15Bq8NEBg=
│  │  │  │  │  │     ├─ NSS9VatKtd11leTHe7gciKPj+Ic=
│  │  │  │  │  │     ├─ O0ElNDcKNgzbxT4He7J0+oW4_bY=
│  │  │  │  │  │     ├─ PK3bDThuMO7B3hXeHT3rqaQSeMk=
│  │  │  │  │  │     ├─ PNBzaPKDkInpKO97QMFjkX0uPLk=
│  │  │  │  │  │     ├─ QrYiaupxoak1o847kYLHmiNzPpo=
│  │  │  │  │  │     ├─ RDDbjVd0FDFFdF1dR29mYPkJ5BY=
│  │  │  │  │  │     ├─ ReqJmPJA2eHjmKQfk4LGnjA3JPU=
│  │  │  │  │  │     ├─ SVJJxbUMpNI65OBKm70KiO9ZbDo=
│  │  │  │  │  │     ├─ SmtTiQMwRcCnbUC9DIVGVKFkXk4=
│  │  │  │  │  │     ├─ SwTT+IbmixK9uQi8B_vqKGMaZRw=
│  │  │  │  │  │     ├─ T0ZiCFmY7fx8dGJxKe43w6rM1NM=
│  │  │  │  │  │     ├─ TDURbNLhl1hPOL1gqDPZoLnMKOM=
│  │  │  │  │  │     ├─ TEhU51S3pFDXq1DWMnJbdKWkVXI=
│  │  │  │  │  │     ├─ TaTPRryN48jL5VfWD3wbmvXrUJM=
│  │  │  │  │  │     ├─ U5Gwiq4xv6ZTy0q4ld0JxNd0kyU=
│  │  │  │  │  │     ├─ UIQeEzUb2+XsDIr5KlWOdBkzqGQ=
│  │  │  │  │  │     ├─ VBRpE1l5psoQ41jEs5l67u+6bWo=
│  │  │  │  │  │     ├─ VEi69U0yExxLuw6Giirk_1dahF4=
│  │  │  │  │  │     ├─ WEICcGEjiKOPLO82JCJ_ZU9FeLs=
│  │  │  │  │  │     ├─ WxjZA2zl23hcyz8ub0UY1Fri_44=
│  │  │  │  │  │     ├─ X5wfPIQByXjbDnJFW2auUmkb1cc=
│  │  │  │  │  │     ├─ YCWoToK2LsGBviYcWKh97uGY0Ws=
│  │  │  │  │  │     ├─ YP8GiwDwbyO1omUWQ+LYK+xyyAM=
│  │  │  │  │  │     ├─ ZToI+J5eZNM0nXMFeqGqabFbwv8=
│  │  │  │  │  │     ├─ ZvvUENrkvcHA+IKsLDlNHJwg_QQ=
│  │  │  │  │  │     ├─ _R3xOYfQBn4HwBw9SX4zb1mSdi4=
│  │  │  │  │  │     ├─ aXTnQtRmkl5zhhuaLy9XIHHtdNk=
│  │  │  │  │  │     ├─ ai_q8kpZRL_zK0L78n61BF6sc9E=
│  │  │  │  │  │     ├─ cFCt5xIN39M4V8Gu6_yxzXd6gh8=
│  │  │  │  │  │     ├─ cVw6Uc03jF_4oBOs5p9b_Z5M9ZI=
│  │  │  │  │  │     ├─ cl9ODd02jHoH3hZkFw3q3kqeRqQ=
│  │  │  │  │  │     ├─ dII_+6kfqY1eruDAnIr557iSKGY=
│  │  │  │  │  │     ├─ dLAbUNvfMyqc+DbigsxTM78N13s=
│  │  │  │  │  │     ├─ ebWTrBrpGumGCHplRSDUfr+JQIE=
│  │  │  │  │  │     ├─ fqD70n3+emLbxJrfxP5Kg4p7KmQ=
│  │  │  │  │  │     ├─ g1lJgCx3sPsVG4KtQaLk__pADZc=
│  │  │  │  │  │     ├─ gpvynAHAppZXNArWz7uJWrs6RAo=
│  │  │  │  │  │     ├─ gq+DByAkh+MzAQHYOyEO3sj+6gQ=
│  │  │  │  │  │     ├─ l3fizNk3HoNri5qnNcXVB19I_V8=
│  │  │  │  │  │     ├─ lgXJYTmvqDIRAgx4czM6amVUuf4=
│  │  │  │  │  │     ├─ lskYU_L7mUsS7W7Bdrj16cEiU74=
│  │  │  │  │  │     ├─ mPvUiNrGm38inija8Lm9AEkGSEY=
│  │  │  │  │  │     ├─ m_64YdIRvlia+xw9eDB53gva7qA=
│  │  │  │  │  │     ├─ nsKRPdXqSQL9f6H88E8KCTzyUcg=
│  │  │  │  │  │     ├─ oiZGb+fIXeNEfF5awS71ZbB+aao=
│  │  │  │  │  │     ├─ ouLBln3cwnCkVw3eXyHFzekhLNU=
│  │  │  │  │  │     ├─ pU8jaGeEF1k8vMmoFQuuS0bxyyQ=
│  │  │  │  │  │     ├─ pbG4u5EYNADQX83RquUqH9KVC4E=
│  │  │  │  │  │     ├─ pfyjFvYk76bUhlMxBrR++litF4I=
│  │  │  │  │  │     ├─ plM53zszzBb8etyqi_sAd2CwYs4=
│  │  │  │  │  │     ├─ qEKPo2HTTEZHXYFZU6ZozoezBks=
│  │  │  │  │  │     ├─ qMerd4TDcldydKFveBQOI6wGIx0=
│  │  │  │  │  │     ├─ qzR+TvkFES1MhsyDw524aVpdP4s=
│  │  │  │  │  │     ├─ r8dukMhfFFnbNlTq0WL2P2m7n_c=
│  │  │  │  │  │     ├─ r_4mnkRnWqKmNUobNCqatsYobyw=
│  │  │  │  │  │     ├─ sepevEeJBjNkSeZY6boILsz2xIA=
│  │  │  │  │  │     ├─ soKdGISF21O3tl5+ujlYxp8kG2E=
│  │  │  │  │  │     ├─ tAc0ntoffkqNZfeocOyWQeo_6uI=
│  │  │  │  │  │     ├─ tI286OQ41RO8+xiUYgyb4VnuKDc=
│  │  │  │  │  │     ├─ tLMMDTdt_Jw_HLLqzmelcfHfJ_o=
│  │  │  │  │  │     ├─ tLsiPshxTjOpa6aEm_ypGllN9N8=
│  │  │  │  │  │     ├─ tZUDCF4EIW4gFQZbLfJ8sCbBIjs=
│  │  │  │  │  │     ├─ tvhCBGM5dkSy90klx_35ymcYyqs=
│  │  │  │  │  │     ├─ u9smVUMRx_MV78COnrtban2tE+Y=
│  │  │  │  │  │     ├─ ugSa8TRsYQ2jfQ5yRJsV+BOzRjA=
│  │  │  │  │  │     ├─ uwAvEKxNKc9M6L2z7N0cUNYZyXs=
│  │  │  │  │  │     ├─ uxsCxjJaxxBgDmAe0CGF_KHBoz4=
│  │  │  │  │  │     ├─ vJPhHrmIZiKUGuZXAt2hnPrVCXQ=
│  │  │  │  │  │     ├─ vPU5v5aKB+WUuf1WxFusGi293As=
│  │  │  │  │  │     ├─ wEIxswytMbULi8bzCjl_fnIbKno=
│  │  │  │  │  │     ├─ wmhyfydFHHCOgi+MuFvSbAelLks=
│  │  │  │  │  │     ├─ xK+rDgOdzDOQk1QuAdqcpsE79ZA=
│  │  │  │  │  │     ├─ xYMQbKm9He4fMebQH4NcUakhDp0=
│  │  │  │  │  │     └─ yXuKSpe9UTNKlm3duIZMlbX9MgY=
│  │  │  │  │  ├─ lintVitalAnalyzeRelease
│  │  │  │  │  │  ├─ module.xml
│  │  │  │  │  │  ├─ release-artifact-dependencies.xml
│  │  │  │  │  │  ├─ release-artifact-libraries.xml
│  │  │  │  │  │  └─ release.xml
│  │  │  │  │  ├─ mergeDebugAssets
│  │  │  │  │  │  └─ merger.xml
│  │  │  │  │  ├─ mergeDebugJniLibFolders
│  │  │  │  │  │  └─ merger.xml
│  │  │  │  │  ├─ mergeDebugShaders
│  │  │  │  │  │  └─ merger.xml
│  │  │  │  │  ├─ mergeReleaseAssets
│  │  │  │  │  │  └─ merger.xml
│  │  │  │  │  ├─ mergeReleaseJniLibFolders
│  │  │  │  │  │  └─ merger.xml
│  │  │  │  │  ├─ mergeReleaseShaders
│  │  │  │  │  │  └─ merger.xml
│  │  │  │  │  ├─ packageDebug
│  │  │  │  │  │  └─ tmp
│  │  │  │  │  │     └─ debug
│  │  │  │  │  │        ├─ dex-renamer-state.txt
│  │  │  │  │  │        └─ zip-cache
│  │  │  │  │  │           ├─ androidResources
│  │  │  │  │  │           └─ javaResources0
│  │  │  │  │  ├─ packageRelease
│  │  │  │  │  │  └─ tmp
│  │  │  │  │  │     └─ release
│  │  │  │  │  │        ├─ dex-renamer-state.txt
│  │  │  │  │  │        └─ zip-cache
│  │  │  │  │  │           ├─ androidResources
│  │  │  │  │  │           └─ javaResources0
│  │  │  │  │  ├─ release
│  │  │  │  │  │  ├─ mergeReleaseResources
│  │  │  │  │  │  │  ├─ compile-file-map.properties
│  │  │  │  │  │  │  ├─ merged.dir
│  │  │  │  │  │  │  │  ├─ values
│  │  │  │  │  │  │  │  │  └─ values.xml
│  │  │  │  │  │  │  │  ├─ values-af
│  │  │  │  │  │  │  │  │  └─ values-af.xml
│  │  │  │  │  │  │  │  ├─ values-am
│  │  │  │  │  │  │  │  │  └─ values-am.xml
│  │  │  │  │  │  │  │  ├─ values-ar
│  │  │  │  │  │  │  │  │  └─ values-ar.xml
│  │  │  │  │  │  │  │  ├─ values-as
│  │  │  │  │  │  │  │  │  └─ values-as.xml
│  │  │  │  │  │  │  │  ├─ values-az
│  │  │  │  │  │  │  │  │  └─ values-az.xml
│  │  │  │  │  │  │  │  ├─ values-b+es+419
│  │  │  │  │  │  │  │  │  └─ values-b+es+419.xml
│  │  │  │  │  │  │  │  ├─ values-b+sr+Latn
│  │  │  │  │  │  │  │  │  └─ values-b+sr+Latn.xml
│  │  │  │  │  │  │  │  ├─ values-be
│  │  │  │  │  │  │  │  │  └─ values-be.xml
│  │  │  │  │  │  │  │  ├─ values-bg
│  │  │  │  │  │  │  │  │  └─ values-bg.xml
│  │  │  │  │  │  │  │  ├─ values-bn
│  │  │  │  │  │  │  │  │  └─ values-bn.xml
│  │  │  │  │  │  │  │  ├─ values-bs
│  │  │  │  │  │  │  │  │  └─ values-bs.xml
│  │  │  │  │  │  │  │  ├─ values-ca
│  │  │  │  │  │  │  │  │  └─ values-ca.xml
│  │  │  │  │  │  │  │  ├─ values-cs
│  │  │  │  │  │  │  │  │  └─ values-cs.xml
│  │  │  │  │  │  │  │  ├─ values-da
│  │  │  │  │  │  │  │  │  └─ values-da.xml
│  │  │  │  │  │  │  │  ├─ values-de
│  │  │  │  │  │  │  │  │  └─ values-de.xml
│  │  │  │  │  │  │  │  ├─ values-el
│  │  │  │  │  │  │  │  │  └─ values-el.xml
│  │  │  │  │  │  │  │  ├─ values-en-rAU
│  │  │  │  │  │  │  │  │  └─ values-en-rAU.xml
│  │  │  │  │  │  │  │  ├─ values-en-rCA
│  │  │  │  │  │  │  │  │  └─ values-en-rCA.xml
│  │  │  │  │  │  │  │  ├─ values-en-rGB
│  │  │  │  │  │  │  │  │  └─ values-en-rGB.xml
│  │  │  │  │  │  │  │  ├─ values-en-rIN
│  │  │  │  │  │  │  │  │  └─ values-en-rIN.xml
│  │  │  │  │  │  │  │  ├─ values-en-rXC
│  │  │  │  │  │  │  │  │  └─ values-en-rXC.xml
│  │  │  │  │  │  │  │  ├─ values-es
│  │  │  │  │  │  │  │  │  └─ values-es.xml
│  │  │  │  │  │  │  │  ├─ values-es-rUS
│  │  │  │  │  │  │  │  │  └─ values-es-rUS.xml
│  │  │  │  │  │  │  │  ├─ values-et
│  │  │  │  │  │  │  │  │  └─ values-et.xml
│  │  │  │  │  │  │  │  ├─ values-eu
│  │  │  │  │  │  │  │  │  └─ values-eu.xml
│  │  │  │  │  │  │  │  ├─ values-fa
│  │  │  │  │  │  │  │  │  └─ values-fa.xml
│  │  │  │  │  │  │  │  ├─ values-fi
│  │  │  │  │  │  │  │  │  └─ values-fi.xml
│  │  │  │  │  │  │  │  ├─ values-fr
│  │  │  │  │  │  │  │  │  └─ values-fr.xml
│  │  │  │  │  │  │  │  ├─ values-fr-rCA
│  │  │  │  │  │  │  │  │  └─ values-fr-rCA.xml
│  │  │  │  │  │  │  │  ├─ values-gl
│  │  │  │  │  │  │  │  │  └─ values-gl.xml
│  │  │  │  │  │  │  │  ├─ values-gu
│  │  │  │  │  │  │  │  │  └─ values-gu.xml
│  │  │  │  │  │  │  │  ├─ values-h320dp-port-v13
│  │  │  │  │  │  │  │  │  └─ values-h320dp-port-v13.xml
│  │  │  │  │  │  │  │  ├─ values-h360dp-land-v13
│  │  │  │  │  │  │  │  │  └─ values-h360dp-land-v13.xml
│  │  │  │  │  │  │  │  ├─ values-h480dp-land-v13
│  │  │  │  │  │  │  │  │  └─ values-h480dp-land-v13.xml
│  │  │  │  │  │  │  │  ├─ values-h550dp-port-v13
│  │  │  │  │  │  │  │  │  └─ values-h550dp-port-v13.xml
│  │  │  │  │  │  │  │  ├─ values-h720dp-v13
│  │  │  │  │  │  │  │  │  └─ values-h720dp-v13.xml
│  │  │  │  │  │  │  │  ├─ values-hdpi-v4
│  │  │  │  │  │  │  │  │  └─ values-hdpi-v4.xml
│  │  │  │  │  │  │  │  ├─ values-hi
│  │  │  │  │  │  │  │  │  └─ values-hi.xml
│  │  │  │  │  │  │  │  ├─ values-hr
│  │  │  │  │  │  │  │  │  └─ values-hr.xml
│  │  │  │  │  │  │  │  ├─ values-hu
│  │  │  │  │  │  │  │  │  └─ values-hu.xml
│  │  │  │  │  │  │  │  ├─ values-hy
│  │  │  │  │  │  │  │  │  └─ values-hy.xml
│  │  │  │  │  │  │  │  ├─ values-in
│  │  │  │  │  │  │  │  │  └─ values-in.xml
│  │  │  │  │  │  │  │  ├─ values-is
│  │  │  │  │  │  │  │  │  └─ values-is.xml
│  │  │  │  │  │  │  │  ├─ values-it
│  │  │  │  │  │  │  │  │  └─ values-it.xml
│  │  │  │  │  │  │  │  ├─ values-iw
│  │  │  │  │  │  │  │  │  └─ values-iw.xml
│  │  │  │  │  │  │  │  ├─ values-ja
│  │  │  │  │  │  │  │  │  └─ values-ja.xml
│  │  │  │  │  │  │  │  ├─ values-ka
│  │  │  │  │  │  │  │  │  └─ values-ka.xml
│  │  │  │  │  │  │  │  ├─ values-kk
│  │  │  │  │  │  │  │  │  └─ values-kk.xml
│  │  │  │  │  │  │  │  ├─ values-km
│  │  │  │  │  │  │  │  │  └─ values-km.xml
│  │  │  │  │  │  │  │  ├─ values-kn
│  │  │  │  │  │  │  │  │  └─ values-kn.xml
│  │  │  │  │  │  │  │  ├─ values-ko
│  │  │  │  │  │  │  │  │  └─ values-ko.xml
│  │  │  │  │  │  │  │  ├─ values-ky
│  │  │  │  │  │  │  │  │  └─ values-ky.xml
│  │  │  │  │  │  │  │  ├─ values-land
│  │  │  │  │  │  │  │  │  └─ values-land.xml
│  │  │  │  │  │  │  │  ├─ values-large-v4
│  │  │  │  │  │  │  │  │  └─ values-large-v4.xml
│  │  │  │  │  │  │  │  ├─ values-ldltr-v21
│  │  │  │  │  │  │  │  │  └─ values-ldltr-v21.xml
│  │  │  │  │  │  │  │  ├─ values-ldrtl-v17
│  │  │  │  │  │  │  │  │  └─ values-ldrtl-v17.xml
│  │  │  │  │  │  │  │  ├─ values-lo
│  │  │  │  │  │  │  │  │  └─ values-lo.xml
│  │  │  │  │  │  │  │  ├─ values-lt
│  │  │  │  │  │  │  │  │  └─ values-lt.xml
│  │  │  │  │  │  │  │  ├─ values-lv
│  │  │  │  │  │  │  │  │  └─ values-lv.xml
│  │  │  │  │  │  │  │  ├─ values-mk
│  │  │  │  │  │  │  │  │  └─ values-mk.xml
│  │  │  │  │  │  │  │  ├─ values-ml
│  │  │  │  │  │  │  │  │  └─ values-ml.xml
│  │  │  │  │  │  │  │  ├─ values-mn
│  │  │  │  │  │  │  │  │  └─ values-mn.xml
│  │  │  │  │  │  │  │  ├─ values-mr
│  │  │  │  │  │  │  │  │  └─ values-mr.xml
│  │  │  │  │  │  │  │  ├─ values-ms
│  │  │  │  │  │  │  │  │  └─ values-ms.xml
│  │  │  │  │  │  │  │  ├─ values-my
│  │  │  │  │  │  │  │  │  └─ values-my.xml
│  │  │  │  │  │  │  │  ├─ values-nb
│  │  │  │  │  │  │  │  │  └─ values-nb.xml
│  │  │  │  │  │  │  │  ├─ values-ne
│  │  │  │  │  │  │  │  │  └─ values-ne.xml
│  │  │  │  │  │  │  │  ├─ values-night-v8
│  │  │  │  │  │  │  │  │  └─ values-night-v8.xml
│  │  │  │  │  │  │  │  ├─ values-nl
│  │  │  │  │  │  │  │  │  └─ values-nl.xml
│  │  │  │  │  │  │  │  ├─ values-or
│  │  │  │  │  │  │  │  │  └─ values-or.xml
│  │  │  │  │  │  │  │  ├─ values-pa
│  │  │  │  │  │  │  │  │  └─ values-pa.xml
│  │  │  │  │  │  │  │  ├─ values-pl
│  │  │  │  │  │  │  │  │  └─ values-pl.xml
│  │  │  │  │  │  │  │  ├─ values-port
│  │  │  │  │  │  │  │  │  └─ values-port.xml
│  │  │  │  │  │  │  │  ├─ values-pt
│  │  │  │  │  │  │  │  │  └─ values-pt.xml
│  │  │  │  │  │  │  │  ├─ values-pt-rBR
│  │  │  │  │  │  │  │  │  └─ values-pt-rBR.xml
│  │  │  │  │  │  │  │  ├─ values-pt-rPT
│  │  │  │  │  │  │  │  │  └─ values-pt-rPT.xml
│  │  │  │  │  │  │  │  ├─ values-ro
│  │  │  │  │  │  │  │  │  └─ values-ro.xml
│  │  │  │  │  │  │  │  ├─ values-ru
│  │  │  │  │  │  │  │  │  └─ values-ru.xml
│  │  │  │  │  │  │  │  ├─ values-si
│  │  │  │  │  │  │  │  │  └─ values-si.xml
│  │  │  │  │  │  │  │  ├─ values-sk
│  │  │  │  │  │  │  │  │  └─ values-sk.xml
│  │  │  │  │  │  │  │  ├─ values-sl
│  │  │  │  │  │  │  │  │  └─ values-sl.xml
│  │  │  │  │  │  │  │  ├─ values-small-v4
│  │  │  │  │  │  │  │  │  └─ values-small-v4.xml
│  │  │  │  │  │  │  │  ├─ values-sq
│  │  │  │  │  │  │  │  │  └─ values-sq.xml
│  │  │  │  │  │  │  │  ├─ values-sr
│  │  │  │  │  │  │  │  │  └─ values-sr.xml
│  │  │  │  │  │  │  │  ├─ values-sv
│  │  │  │  │  │  │  │  │  └─ values-sv.xml
│  │  │  │  │  │  │  │  ├─ values-sw
│  │  │  │  │  │  │  │  │  └─ values-sw.xml
│  │  │  │  │  │  │  │  ├─ values-sw600dp-v13
│  │  │  │  │  │  │  │  │  └─ values-sw600dp-v13.xml
│  │  │  │  │  │  │  │  ├─ values-ta
│  │  │  │  │  │  │  │  │  └─ values-ta.xml
│  │  │  │  │  │  │  │  ├─ values-te
│  │  │  │  │  │  │  │  │  └─ values-te.xml
│  │  │  │  │  │  │  │  ├─ values-th
│  │  │  │  │  │  │  │  │  └─ values-th.xml
│  │  │  │  │  │  │  │  ├─ values-tl
│  │  │  │  │  │  │  │  │  └─ values-tl.xml
│  │  │  │  │  │  │  │  ├─ values-tr
│  │  │  │  │  │  │  │  │  └─ values-tr.xml
│  │  │  │  │  │  │  │  ├─ values-uk
│  │  │  │  │  │  │  │  │  └─ values-uk.xml
│  │  │  │  │  │  │  │  ├─ values-ur
│  │  │  │  │  │  │  │  │  └─ values-ur.xml
│  │  │  │  │  │  │  │  ├─ values-uz
│  │  │  │  │  │  │  │  │  └─ values-uz.xml
│  │  │  │  │  │  │  │  ├─ values-v16
│  │  │  │  │  │  │  │  │  └─ values-v16.xml
│  │  │  │  │  │  │  │  ├─ values-v17
│  │  │  │  │  │  │  │  │  └─ values-v17.xml
│  │  │  │  │  │  │  │  ├─ values-v18
│  │  │  │  │  │  │  │  │  └─ values-v18.xml
│  │  │  │  │  │  │  │  ├─ values-v21
│  │  │  │  │  │  │  │  │  └─ values-v21.xml
│  │  │  │  │  │  │  │  ├─ values-v22
│  │  │  │  │  │  │  │  │  └─ values-v22.xml
│  │  │  │  │  │  │  │  ├─ values-v23
│  │  │  │  │  │  │  │  │  └─ values-v23.xml
│  │  │  │  │  │  │  │  ├─ values-v24
│  │  │  │  │  │  │  │  │  └─ values-v24.xml
│  │  │  │  │  │  │  │  ├─ values-v25
│  │  │  │  │  │  │  │  │  └─ values-v25.xml
│  │  │  │  │  │  │  │  ├─ values-v26
│  │  │  │  │  │  │  │  │  └─ values-v26.xml
│  │  │  │  │  │  │  │  ├─ values-v27
│  │  │  │  │  │  │  │  │  └─ values-v27.xml
│  │  │  │  │  │  │  │  ├─ values-v28
│  │  │  │  │  │  │  │  │  └─ values-v28.xml
│  │  │  │  │  │  │  │  ├─ values-v29
│  │  │  │  │  │  │  │  │  └─ values-v29.xml
│  │  │  │  │  │  │  │  ├─ values-v30
│  │  │  │  │  │  │  │  │  └─ values-v30.xml
│  │  │  │  │  │  │  │  ├─ values-v31
│  │  │  │  │  │  │  │  │  └─ values-v31.xml
│  │  │  │  │  │  │  │  ├─ values-v34
│  │  │  │  │  │  │  │  │  └─ values-v34.xml
│  │  │  │  │  │  │  │  ├─ values-vi
│  │  │  │  │  │  │  │  │  └─ values-vi.xml
│  │  │  │  │  │  │  │  ├─ values-w320dp-land-v13
│  │  │  │  │  │  │  │  │  └─ values-w320dp-land-v13.xml
│  │  │  │  │  │  │  │  ├─ values-w360dp-port-v13
│  │  │  │  │  │  │  │  │  └─ values-w360dp-port-v13.xml
│  │  │  │  │  │  │  │  ├─ values-w400dp-port-v13
│  │  │  │  │  │  │  │  │  └─ values-w400dp-port-v13.xml
│  │  │  │  │  │  │  │  ├─ values-w600dp-land-v13
│  │  │  │  │  │  │  │  │  └─ values-w600dp-land-v13.xml
│  │  │  │  │  │  │  │  ├─ values-watch-v20
│  │  │  │  │  │  │  │  │  └─ values-watch-v20.xml
│  │  │  │  │  │  │  │  ├─ values-watch-v21
│  │  │  │  │  │  │  │  │  └─ values-watch-v21.xml
│  │  │  │  │  │  │  │  ├─ values-xlarge-v4
│  │  │  │  │  │  │  │  │  └─ values-xlarge-v4.xml
│  │  │  │  │  │  │  │  ├─ values-zh-rCN
│  │  │  │  │  │  │  │  │  └─ values-zh-rCN.xml
│  │  │  │  │  │  │  │  ├─ values-zh-rHK
│  │  │  │  │  │  │  │  │  └─ values-zh-rHK.xml
│  │  │  │  │  │  │  │  ├─ values-zh-rTW
│  │  │  │  │  │  │  │  │  └─ values-zh-rTW.xml
│  │  │  │  │  │  │  │  └─ values-zu
│  │  │  │  │  │  │  │     └─ values-zu.xml
│  │  │  │  │  │  │  ├─ merger.xml
│  │  │  │  │  │  │  └─ stripped.dir
│  │  │  │  │  │  └─ packageReleaseResources
│  │  │  │  │  │     ├─ compile-file-map.properties
│  │  │  │  │  │     ├─ merged.dir
│  │  │  │  │  │     │  └─ values
│  │  │  │  │  │     │     └─ values.xml
│  │  │  │  │  │     ├─ merger.xml
│  │  │  │  │  │     └─ stripped.dir
│  │  │  │  │  └─ release-mergeJavaRes
│  │  │  │  │     ├─ merge-state
│  │  │  │  │     └─ zip-cache
│  │  │  │  │        ├─ +7uvEsvCJvLxfjsUOM4qgqoqFrM=
│  │  │  │  │        ├─ 07SPiUxYVmpV2q1khR0LqhRDXzU=
│  │  │  │  │        ├─ 0K4ndy1jlu8HuG6GP3XFgZ0ky4Q=
│  │  │  │  │        ├─ 2fv5uu0uFpKgQJO0DmMA5ucU0os=
│  │  │  │  │        ├─ 3qgaWoc5VFSNxyfQ+XRUDsw7jns=
│  │  │  │  │        ├─ 3xRjMvBYHTvsFxpheplTGxqfpVU=
│  │  │  │  │        ├─ 4VIbSTsAF9BE6+1Dczq5SMJ5lQ8=
│  │  │  │  │        ├─ 5NjURmHlnt9LVMmhDaJZZXA3qeY=
│  │  │  │  │        ├─ 5smE6xPwqRgMEJm_EzFv9HD8EEQ=
│  │  │  │  │        ├─ 5xJapfvl99HAfn9DUKqtVNbc9r4=
│  │  │  │  │        ├─ 65ehIK_E4WvKBN8PRX+suvd1PIg=
│  │  │  │  │        ├─ 6YfqiIHDER5Drmw_nr6pgI0RURw=
│  │  │  │  │        ├─ 6tNCpKYmWLICLt8VPeintDHNZ3g=
│  │  │  │  │        ├─ 784Zz1OsjLqO8v+xld2_74OYjDg=
│  │  │  │  │        ├─ 8OmbJWihVtUjs0fG1aqwXW47UCY=
│  │  │  │  │        ├─ 8_7kfYUihQsz7BRedVxofsMYH7k=
│  │  │  │  │        ├─ 9mffXhdPcPwoAneVCA+WBfst18M=
│  │  │  │  │        ├─ 9peWXfV7eiCIwxdj+wVkvnZ5GhI=
│  │  │  │  │        ├─ AC91TKcbNXgVKS+pflVIgS4d20k=
│  │  │  │  │        ├─ AJO9wZbOsqcNkaSCsagjsO8i79U=
│  │  │  │  │        ├─ AtxkoY5KUGR4nsEC314NOE0QaCE=
│  │  │  │  │        ├─ BvJb71GCE4AWBJ3r5jQLazBREvo=
│  │  │  │  │        ├─ C4v4NXgLepghnSVFoc9w_wu41AQ=
│  │  │  │  │        ├─ CUahqEC+J_mNhou7s0SiqxpcUVk=
│  │  │  │  │        ├─ Cg7GjBSxHnfhIQ4goA30FTfK_QM=
│  │  │  │  │        ├─ CqwN4w0EHaTIYicWDZCi0FVsy4Q=
│  │  │  │  │        ├─ DFOaWjghZE4472nkh0jxruboqZU=
│  │  │  │  │        ├─ DYMQg0JHYdoOfZ3spy5hDehjSSs=
│  │  │  │  │        ├─ Dv+C2bxtie5_hp7A0se5MtnnJPA=
│  │  │  │  │        ├─ DxKvWob7RnBsJdlQX82h9OgBtso=
│  │  │  │  │        ├─ EXkPiE1lYjfH5nGz1kqDQD6QhzU=
│  │  │  │  │        ├─ F+aWsPl92__aCgoDOraz_pty_1A=
│  │  │  │  │        ├─ FhYYYM4fX+MkxjYTG_fQWHHmMhY=
│  │  │  │  │        ├─ G4yNALmFMEpNZUFV0RTTMdjH3jA=
│  │  │  │  │        ├─ GOOPA3HyoWnXQYxizS+YocgADWk=
│  │  │  │  │        ├─ HiCPBLtqNEbWSl+ItPj7zYb3RNY=
│  │  │  │  │        ├─ HrbXUnAcEXe2x4m5R1I8yQw3OfA=
│  │  │  │  │        ├─ Hu65l5MmtlZ7BqVCuwc2B50XOF4=
│  │  │  │  │        ├─ I_WxXPsLxktiocR4jwNeWfoZW1c=
│  │  │  │  │        ├─ J+uJGcRpsz3uGkovPWMK3wH6Dvg=
│  │  │  │  │        ├─ JdGS1Yr9czI7lLnIwcokLdPpmOw=
│  │  │  │  │        ├─ Jj3HMouU1pY1o_esxO0au9FBi4Q=
│  │  │  │  │        ├─ Kho3g4+W_OdBV3SKCZCRIzYP7Wc=
│  │  │  │  │        ├─ NDHOPcqVrt3J5dO8EA15Bq8NEBg=
│  │  │  │  │        ├─ NSS9VatKtd11leTHe7gciKPj+Ic=
│  │  │  │  │        ├─ O0ElNDcKNgzbxT4He7J0+oW4_bY=
│  │  │  │  │        ├─ PK3bDThuMO7B3hXeHT3rqaQSeMk=
│  │  │  │  │        ├─ PNBzaPKDkInpKO97QMFjkX0uPLk=
│  │  │  │  │        ├─ QrYiaupxoak1o847kYLHmiNzPpo=
│  │  │  │  │        ├─ RDDbjVd0FDFFdF1dR29mYPkJ5BY=
│  │  │  │  │        ├─ ReqJmPJA2eHjmKQfk4LGnjA3JPU=
│  │  │  │  │        ├─ SVJJxbUMpNI65OBKm70KiO9ZbDo=
│  │  │  │  │        ├─ SmtTiQMwRcCnbUC9DIVGVKFkXk4=
│  │  │  │  │        ├─ SwTT+IbmixK9uQi8B_vqKGMaZRw=
│  │  │  │  │        ├─ T0ZiCFmY7fx8dGJxKe43w6rM1NM=
│  │  │  │  │        ├─ TDURbNLhl1hPOL1gqDPZoLnMKOM=
│  │  │  │  │        ├─ TEhU51S3pFDXq1DWMnJbdKWkVXI=
│  │  │  │  │        ├─ TaTPRryN48jL5VfWD3wbmvXrUJM=
│  │  │  │  │        ├─ U5Gwiq4xv6ZTy0q4ld0JxNd0kyU=
│  │  │  │  │        ├─ UIQeEzUb2+XsDIr5KlWOdBkzqGQ=
│  │  │  │  │        ├─ VBRpE1l5psoQ41jEs5l67u+6bWo=
│  │  │  │  │        ├─ VEi69U0yExxLuw6Giirk_1dahF4=
│  │  │  │  │        ├─ WEICcGEjiKOPLO82JCJ_ZU9FeLs=
│  │  │  │  │        ├─ WxjZA2zl23hcyz8ub0UY1Fri_44=
│  │  │  │  │        ├─ X5wfPIQByXjbDnJFW2auUmkb1cc=
│  │  │  │  │        ├─ YCWoToK2LsGBviYcWKh97uGY0Ws=
│  │  │  │  │        ├─ YP8GiwDwbyO1omUWQ+LYK+xyyAM=
│  │  │  │  │        ├─ ZToI+J5eZNM0nXMFeqGqabFbwv8=
│  │  │  │  │        ├─ ZvvUENrkvcHA+IKsLDlNHJwg_QQ=
│  │  │  │  │        ├─ _R3xOYfQBn4HwBw9SX4zb1mSdi4=
│  │  │  │  │        ├─ aXTnQtRmkl5zhhuaLy9XIHHtdNk=
│  │  │  │  │        ├─ ai_q8kpZRL_zK0L78n61BF6sc9E=
│  │  │  │  │        ├─ cFCt5xIN39M4V8Gu6_yxzXd6gh8=
│  │  │  │  │        ├─ cVw6Uc03jF_4oBOs5p9b_Z5M9ZI=
│  │  │  │  │        ├─ cl9ODd02jHoH3hZkFw3q3kqeRqQ=
│  │  │  │  │        ├─ dII_+6kfqY1eruDAnIr557iSKGY=
│  │  │  │  │        ├─ dLAbUNvfMyqc+DbigsxTM78N13s=
│  │  │  │  │        ├─ ebWTrBrpGumGCHplRSDUfr+JQIE=
│  │  │  │  │        ├─ fqD70n3+emLbxJrfxP5Kg4p7KmQ=
│  │  │  │  │        ├─ g1lJgCx3sPsVG4KtQaLk__pADZc=
│  │  │  │  │        ├─ gpvynAHAppZXNArWz7uJWrs6RAo=
│  │  │  │  │        ├─ gq+DByAkh+MzAQHYOyEO3sj+6gQ=
│  │  │  │  │        ├─ l3fizNk3HoNri5qnNcXVB19I_V8=
│  │  │  │  │        ├─ lgXJYTmvqDIRAgx4czM6amVUuf4=
│  │  │  │  │        ├─ lskYU_L7mUsS7W7Bdrj16cEiU74=
│  │  │  │  │        ├─ mPvUiNrGm38inija8Lm9AEkGSEY=
│  │  │  │  │        ├─ m_64YdIRvlia+xw9eDB53gva7qA=
│  │  │  │  │        ├─ nsKRPdXqSQL9f6H88E8KCTzyUcg=
│  │  │  │  │        ├─ oiZGb+fIXeNEfF5awS71ZbB+aao=
│  │  │  │  │        ├─ ouLBln3cwnCkVw3eXyHFzekhLNU=
│  │  │  │  │        ├─ pU8jaGeEF1k8vMmoFQuuS0bxyyQ=
│  │  │  │  │        ├─ pbG4u5EYNADQX83RquUqH9KVC4E=
│  │  │  │  │        ├─ pfyjFvYk76bUhlMxBrR++litF4I=
│  │  │  │  │        ├─ plM53zszzBb8etyqi_sAd2CwYs4=
│  │  │  │  │        ├─ qEKPo2HTTEZHXYFZU6ZozoezBks=
│  │  │  │  │        ├─ qMerd4TDcldydKFveBQOI6wGIx0=
│  │  │  │  │        ├─ qzR+TvkFES1MhsyDw524aVpdP4s=
│  │  │  │  │        ├─ r8dukMhfFFnbNlTq0WL2P2m7n_c=
│  │  │  │  │        ├─ r_4mnkRnWqKmNUobNCqatsYobyw=
│  │  │  │  │        ├─ sepevEeJBjNkSeZY6boILsz2xIA=
│  │  │  │  │        ├─ soKdGISF21O3tl5+ujlYxp8kG2E=
│  │  │  │  │        ├─ tAc0ntoffkqNZfeocOyWQeo_6uI=
│  │  │  │  │        ├─ tI286OQ41RO8+xiUYgyb4VnuKDc=
│  │  │  │  │        ├─ tLMMDTdt_Jw_HLLqzmelcfHfJ_o=
│  │  │  │  │        ├─ tLsiPshxTjOpa6aEm_ypGllN9N8=
│  │  │  │  │        ├─ tZUDCF4EIW4gFQZbLfJ8sCbBIjs=
│  │  │  │  │        ├─ tvhCBGM5dkSy90klx_35ymcYyqs=
│  │  │  │  │        ├─ u9smVUMRx_MV78COnrtban2tE+Y=
│  │  │  │  │        ├─ ugSa8TRsYQ2jfQ5yRJsV+BOzRjA=
│  │  │  │  │        ├─ uwAvEKxNKc9M6L2z7N0cUNYZyXs=
│  │  │  │  │        ├─ uxsCxjJaxxBgDmAe0CGF_KHBoz4=
│  │  │  │  │        ├─ vJPhHrmIZiKUGuZXAt2hnPrVCXQ=
│  │  │  │  │        ├─ vPU5v5aKB+WUuf1WxFusGi293As=
│  │  │  │  │        ├─ wEIxswytMbULi8bzCjl_fnIbKno=
│  │  │  │  │        ├─ wmhyfydFHHCOgi+MuFvSbAelLks=
│  │  │  │  │        ├─ xK+rDgOdzDOQk1QuAdqcpsE79ZA=
│  │  │  │  │        ├─ xYMQbKm9He4fMebQH4NcUakhDp0=
│  │  │  │  │        └─ yXuKSpe9UTNKlm3duIZMlbX9MgY=
│  │  │  │  ├─ intermediary_bundle
│  │  │  │  │  └─ release
│  │  │  │  │     └─ packageReleaseBundle
│  │  │  │  │        └─ intermediary-bundle.aab
│  │  │  │  ├─ java_res
│  │  │  │  │  └─ release
│  │  │  │  │     └─ processReleaseJavaRes
│  │  │  │  │        └─ out
│  │  │  │  │           └─ kotlin-tooling-metadata.json
│  │  │  │  ├─ javac
│  │  │  │  │  ├─ debug
│  │  │  │  │  │  └─ compileDebugJavaWithJavac
│  │  │  │  │  │     └─ classes
│  │  │  │  │  │        └─ optn
│  │  │  │  │  │           └─ wallet
│  │  │  │  │  │              └─ app
│  │  │  │  │  │                 └─ MainActivity.class
│  │  │  │  │  └─ release
│  │  │  │  │     └─ compileReleaseJavaWithJavac
│  │  │  │  │        └─ classes
│  │  │  │  │           └─ optn
│  │  │  │  │              └─ wallet
│  │  │  │  │                 └─ app
│  │  │  │  │                    └─ MainActivity.class
│  │  │  │  ├─ linked_resources_binary_format
│  │  │  │  │  ├─ debug
│  │  │  │  │  │  └─ processDebugResources
│  │  │  │  │  │     ├─ linked-resources-binary-format-debug.ap_
│  │  │  │  │  │     └─ output-metadata.json
│  │  │  │  │  └─ release
│  │  │  │  │     └─ processReleaseResources
│  │  │  │  │        ├─ linked-resources-binary-format-release.ap_
│  │  │  │  │        └─ output-metadata.json
│  │  │  │  ├─ linked_resources_for_bundle_proto_format
│  │  │  │  │  └─ release
│  │  │  │  │     └─ bundleReleaseResources
│  │  │  │  │        └─ linked-resources-proto-format.ap_
│  │  │  │  ├─ lint-cache
│  │  │  │  │  ├─ lintVitalAnalyzeRelease
│  │  │  │  │  │  ├─ lint-cache-version.txt
│  │  │  │  │  │  ├─ maven.google
│  │  │  │  │  │  │  ├─ androidx
│  │  │  │  │  │  │  │  ├─ appcompat
│  │  │  │  │  │  │  │  │  └─ group-index.xml
│  │  │  │  │  │  │  │  ├─ coordinatorlayout
│  │  │  │  │  │  │  │  │  └─ group-index.xml
│  │  │  │  │  │  │  │  └─ core
│  │  │  │  │  │  │  │     └─ group-index.xml
│  │  │  │  │  │  │  ├─ master-index.xml
│  │  │  │  │  │  │  └─ org
│  │  │  │  │  │  │     └─ jetbrains
│  │  │  │  │  │  │        └─ kotlin
│  │  │  │  │  │  │           └─ group-index.xml
│  │  │  │  │  │  ├─ migrated-jars
│  │  │  │  │  │  │  ├─ androidx.compose.runtime.lint.RuntimeIssueRegistry-398cfe4c3e0a311f..jar
│  │  │  │  │  │  │  ├─ androidx.compose.ui.lint.UiIssueRegistry-15f668e0aab039cc..jar
│  │  │  │  │  │  │  └─ androidx.lifecycle.lint.LiveDataCoreIssueRegistry-40d4908416c7a8aa..jar
│  │  │  │  │  │  └─ sdk_index
│  │  │  │  │  │     └─ snapshot.gz
│  │  │  │  │  └─ lintVitalReportRelease
│  │  │  │  │     └─ lint-cache-version.txt
│  │  │  │  ├─ lint_vital_intermediate_text_report
│  │  │  │  │  └─ release
│  │  │  │  │     └─ lintVitalReportRelease
│  │  │  │  │        └─ lint-results-release.txt
│  │  │  │  ├─ lint_vital_partial_results
│  │  │  │  │  └─ release
│  │  │  │  │     └─ lintVitalAnalyzeRelease
│  │  │  │  │        └─ out
│  │  │  │  │           └─ lint-resources.xml
│  │  │  │  ├─ lint_vital_report_lint_model
│  │  │  │  │  └─ release
│  │  │  │  │     └─ generateReleaseLintVitalReportModel
│  │  │  │  │        ├─ module.xml
│  │  │  │  │        ├─ release-artifact-dependencies.xml
│  │  │  │  │        ├─ release-artifact-libraries.xml
│  │  │  │  │        └─ release.xml
│  │  │  │  ├─ lint_vital_return_value
│  │  │  │  │  └─ release
│  │  │  │  │     └─ lintVitalReportRelease
│  │  │  │  │        └─ return-value-release.txt
│  │  │  │  ├─ local_only_symbol_list
│  │  │  │  │  ├─ debug
│  │  │  │  │  │  └─ parseDebugLocalResources
│  │  │  │  │  │     └─ R-def.txt
│  │  │  │  │  └─ release
│  │  │  │  │     └─ parseReleaseLocalResources
│  │  │  │  │        └─ R-def.txt
│  │  │  │  ├─ manifest_merge_blame_file
│  │  │  │  │  ├─ debug
│  │  │  │  │  │  └─ processDebugMainManifest
│  │  │  │  │  │     └─ manifest-merger-blame-debug-report.txt
│  │  │  │  │  └─ release
│  │  │  │  │     └─ processReleaseMainManifest
│  │  │  │  │        └─ manifest-merger-blame-release-report.txt
│  │  │  │  ├─ merged_art_profile
│  │  │  │  │  └─ release
│  │  │  │  │     └─ mergeReleaseArtProfile
│  │  │  │  │        └─ baseline-prof.txt
│  │  │  │  ├─ merged_java_res
│  │  │  │  │  ├─ debug
│  │  │  │  │  │  └─ mergeDebugJavaResource
│  │  │  │  │  │     └─ base.jar
│  │  │  │  │  └─ release
│  │  │  │  │     └─ mergeReleaseJavaResource
│  │  │  │  │        └─ base.jar
│  │  │  │  ├─ merged_jni_libs
│  │  │  │  │  ├─ debug
│  │  │  │  │  │  └─ mergeDebugJniLibFolders
│  │  │  │  │  │     └─ out
│  │  │  │  │  └─ release
│  │  │  │  │     └─ mergeReleaseJniLibFolders
│  │  │  │  │        └─ out
│  │  │  │  ├─ merged_manifest
│  │  │  │  │  ├─ debug
│  │  │  │  │  │  └─ processDebugMainManifest
│  │  │  │  │  │     └─ AndroidManifest.xml
│  │  │  │  │  └─ release
│  │  │  │  │     └─ processReleaseMainManifest
│  │  │  │  │        └─ AndroidManifest.xml
│  │  │  │  ├─ merged_manifests
│  │  │  │  │  ├─ debug
│  │  │  │  │  │  └─ processDebugManifest
│  │  │  │  │  │     ├─ AndroidManifest.xml
│  │  │  │  │  │     └─ output-metadata.json
│  │  │  │  │  └─ release
│  │  │  │  │     └─ processReleaseManifest
│  │  │  │  │        ├─ AndroidManifest.xml
│  │  │  │  │        └─ output-metadata.json
│  │  │  │  ├─ merged_native_libs
│  │  │  │  │  ├─ debug
│  │  │  │  │  │  └─ mergeDebugNativeLibs
│  │  │  │  │  │     └─ out
│  │  │  │  │  │        └─ lib
│  │  │  │  │  │           ├─ arm64-v8a
│  │  │  │  │  │           │  ├─ libandroidx.graphics.path.so
│  │  │  │  │  │           │  ├─ libbarhopper_v3.so
│  │  │  │  │  │           │  └─ libimage_processing_util_jni.so
│  │  │  │  │  │           ├─ armeabi-v7a
│  │  │  │  │  │           │  ├─ libandroidx.graphics.path.so
│  │  │  │  │  │           │  ├─ libbarhopper_v3.so
│  │  │  │  │  │           │  └─ libimage_processing_util_jni.so
│  │  │  │  │  │           ├─ x86
│  │  │  │  │  │           │  ├─ libandroidx.graphics.path.so
│  │  │  │  │  │           │  ├─ libbarhopper_v3.so
│  │  │  │  │  │           │  └─ libimage_processing_util_jni.so
│  │  │  │  │  │           └─ x86_64
│  │  │  │  │  │              ├─ libandroidx.graphics.path.so
│  │  │  │  │  │              ├─ libbarhopper_v3.so
│  │  │  │  │  │              └─ libimage_processing_util_jni.so
│  │  │  │  │  └─ release
│  │  │  │  │     └─ mergeReleaseNativeLibs
│  │  │  │  │        └─ out
│  │  │  │  │           └─ lib
│  │  │  │  │              ├─ arm64-v8a
│  │  │  │  │              │  ├─ libandroidx.graphics.path.so
│  │  │  │  │              │  ├─ libbarhopper_v3.so
│  │  │  │  │              │  └─ libimage_processing_util_jni.so
│  │  │  │  │              ├─ armeabi-v7a
│  │  │  │  │              │  ├─ libandroidx.graphics.path.so
│  │  │  │  │              │  ├─ libbarhopper_v3.so
│  │  │  │  │              │  └─ libimage_processing_util_jni.so
│  │  │  │  │              ├─ x86
│  │  │  │  │              │  ├─ libandroidx.graphics.path.so
│  │  │  │  │              │  ├─ libbarhopper_v3.so
│  │  │  │  │              │  └─ libimage_processing_util_jni.so
│  │  │  │  │              └─ x86_64
│  │  │  │  │                 ├─ libandroidx.graphics.path.so
│  │  │  │  │                 ├─ libbarhopper_v3.so
│  │  │  │  │                 └─ libimage_processing_util_jni.so
│  │  │  │  ├─ merged_res
│  │  │  │  │  ├─ debug
│  │  │  │  │  │  └─ mergeDebugResources
│  │  │  │  │  │     ├─ drawable-land-hdpi_splash.png.flat
│  │  │  │  │  │     ├─ drawable-land-ldpi_splash.png.flat
│  │  │  │  │  │     ├─ drawable-land-mdpi_splash.png.flat
│  │  │  │  │  │     ├─ drawable-land-xhdpi_splash.png.flat
│  │  │  │  │  │     ├─ drawable-land-xxhdpi_splash.png.flat
│  │  │  │  │  │     ├─ drawable-land-xxxhdpi_splash.png.flat
│  │  │  │  │  │     ├─ drawable-port-hdpi_splash.png.flat
│  │  │  │  │  │     ├─ drawable-port-ldpi_splash.png.flat
│  │  │  │  │  │     ├─ drawable-port-mdpi_splash.png.flat
│  │  │  │  │  │     ├─ drawable-port-xhdpi_splash.png.flat
│  │  │  │  │  │     ├─ drawable-port-xxhdpi_splash.png.flat
│  │  │  │  │  │     ├─ drawable-port-xxxhdpi_splash.png.flat
│  │  │  │  │  │     ├─ drawable-v24_ic_launcher_foreground.xml.flat
│  │  │  │  │  │     ├─ drawable_ic_launcher_background.xml.flat
│  │  │  │  │  │     ├─ drawable_splash.png.flat
│  │  │  │  │  │     ├─ layout_activity_main.xml.flat
│  │  │  │  │  │     ├─ mipmap-anydpi-v26_ic_launcher.xml.flat
│  │  │  │  │  │     ├─ mipmap-anydpi-v26_ic_launcher_round.xml.flat
│  │  │  │  │  │     ├─ mipmap-hdpi_ic_launcher.png.flat
│  │  │  │  │  │     ├─ mipmap-hdpi_ic_launcher_foreground.png.flat
│  │  │  │  │  │     ├─ mipmap-hdpi_ic_launcher_round.png.flat
│  │  │  │  │  │     ├─ mipmap-ldpi_ic_launcher.png.flat
│  │  │  │  │  │     ├─ mipmap-mdpi_ic_launcher.png.flat
│  │  │  │  │  │     ├─ mipmap-mdpi_ic_launcher_foreground.png.flat
│  │  │  │  │  │     ├─ mipmap-mdpi_ic_launcher_round.png.flat
│  │  │  │  │  │     ├─ mipmap-xhdpi_ic_launcher.png.flat
│  │  │  │  │  │     ├─ mipmap-xhdpi_ic_launcher_foreground.png.flat
│  │  │  │  │  │     ├─ mipmap-xhdpi_ic_launcher_round.png.flat
│  │  │  │  │  │     ├─ mipmap-xxhdpi_ic_launcher.png.flat
│  │  │  │  │  │     ├─ mipmap-xxhdpi_ic_launcher_foreground.png.flat
│  │  │  │  │  │     ├─ mipmap-xxhdpi_ic_launcher_round.png.flat
│  │  │  │  │  │     ├─ mipmap-xxxhdpi_ic_launcher.png.flat
│  │  │  │  │  │     ├─ mipmap-xxxhdpi_ic_launcher_foreground.png.flat
│  │  │  │  │  │     ├─ mipmap-xxxhdpi_ic_launcher_round.png.flat
│  │  │  │  │  │     ├─ values-af_values-af.arsc.flat
│  │  │  │  │  │     ├─ values-am_values-am.arsc.flat
│  │  │  │  │  │     ├─ values-ar_values-ar.arsc.flat
│  │  │  │  │  │     ├─ values-as_values-as.arsc.flat
│  │  │  │  │  │     ├─ values-az_values-az.arsc.flat
│  │  │  │  │  │     ├─ values-b+es+419_values-b+es+419.arsc.flat
│  │  │  │  │  │     ├─ values-b+sr+Latn_values-b+sr+Latn.arsc.flat
│  │  │  │  │  │     ├─ values-be_values-be.arsc.flat
│  │  │  │  │  │     ├─ values-bg_values-bg.arsc.flat
│  │  │  │  │  │     ├─ values-bn_values-bn.arsc.flat
│  │  │  │  │  │     ├─ values-bs_values-bs.arsc.flat
│  │  │  │  │  │     ├─ values-ca_values-ca.arsc.flat
│  │  │  │  │  │     ├─ values-cs_values-cs.arsc.flat
│  │  │  │  │  │     ├─ values-da_values-da.arsc.flat
│  │  │  │  │  │     ├─ values-de_values-de.arsc.flat
│  │  │  │  │  │     ├─ values-el_values-el.arsc.flat
│  │  │  │  │  │     ├─ values-en-rAU_values-en-rAU.arsc.flat
│  │  │  │  │  │     ├─ values-en-rCA_values-en-rCA.arsc.flat
│  │  │  │  │  │     ├─ values-en-rGB_values-en-rGB.arsc.flat
│  │  │  │  │  │     ├─ values-en-rIN_values-en-rIN.arsc.flat
│  │  │  │  │  │     ├─ values-en-rXC_values-en-rXC.arsc.flat
│  │  │  │  │  │     ├─ values-es-rUS_values-es-rUS.arsc.flat
│  │  │  │  │  │     ├─ values-es_values-es.arsc.flat
│  │  │  │  │  │     ├─ values-et_values-et.arsc.flat
│  │  │  │  │  │     ├─ values-eu_values-eu.arsc.flat
│  │  │  │  │  │     ├─ values-fa_values-fa.arsc.flat
│  │  │  │  │  │     ├─ values-fi_values-fi.arsc.flat
│  │  │  │  │  │     ├─ values-fr-rCA_values-fr-rCA.arsc.flat
│  │  │  │  │  │     ├─ values-fr_values-fr.arsc.flat
│  │  │  │  │  │     ├─ values-gl_values-gl.arsc.flat
│  │  │  │  │  │     ├─ values-gu_values-gu.arsc.flat
│  │  │  │  │  │     ├─ values-h320dp-port-v13_values-h320dp-port-v13.arsc.flat
│  │  │  │  │  │     ├─ values-h360dp-land-v13_values-h360dp-land-v13.arsc.flat
│  │  │  │  │  │     ├─ values-h480dp-land-v13_values-h480dp-land-v13.arsc.flat
│  │  │  │  │  │     ├─ values-h550dp-port-v13_values-h550dp-port-v13.arsc.flat
│  │  │  │  │  │     ├─ values-h720dp-v13_values-h720dp-v13.arsc.flat
│  │  │  │  │  │     ├─ values-hdpi-v4_values-hdpi-v4.arsc.flat
│  │  │  │  │  │     ├─ values-hi_values-hi.arsc.flat
│  │  │  │  │  │     ├─ values-hr_values-hr.arsc.flat
│  │  │  │  │  │     ├─ values-hu_values-hu.arsc.flat
│  │  │  │  │  │     ├─ values-hy_values-hy.arsc.flat
│  │  │  │  │  │     ├─ values-in_values-in.arsc.flat
│  │  │  │  │  │     ├─ values-is_values-is.arsc.flat
│  │  │  │  │  │     ├─ values-it_values-it.arsc.flat
│  │  │  │  │  │     ├─ values-iw_values-iw.arsc.flat
│  │  │  │  │  │     ├─ values-ja_values-ja.arsc.flat
│  │  │  │  │  │     ├─ values-ka_values-ka.arsc.flat
│  │  │  │  │  │     ├─ values-kk_values-kk.arsc.flat
│  │  │  │  │  │     ├─ values-km_values-km.arsc.flat
│  │  │  │  │  │     ├─ values-kn_values-kn.arsc.flat
│  │  │  │  │  │     ├─ values-ko_values-ko.arsc.flat
│  │  │  │  │  │     ├─ values-ky_values-ky.arsc.flat
│  │  │  │  │  │     ├─ values-land_values-land.arsc.flat
│  │  │  │  │  │     ├─ values-large-v4_values-large-v4.arsc.flat
│  │  │  │  │  │     ├─ values-ldltr-v21_values-ldltr-v21.arsc.flat
│  │  │  │  │  │     ├─ values-ldrtl-v17_values-ldrtl-v17.arsc.flat
│  │  │  │  │  │     ├─ values-lo_values-lo.arsc.flat
│  │  │  │  │  │     ├─ values-lt_values-lt.arsc.flat
│  │  │  │  │  │     ├─ values-lv_values-lv.arsc.flat
│  │  │  │  │  │     ├─ values-mk_values-mk.arsc.flat
│  │  │  │  │  │     ├─ values-ml_values-ml.arsc.flat
│  │  │  │  │  │     ├─ values-mn_values-mn.arsc.flat
│  │  │  │  │  │     ├─ values-mr_values-mr.arsc.flat
│  │  │  │  │  │     ├─ values-ms_values-ms.arsc.flat
│  │  │  │  │  │     ├─ values-my_values-my.arsc.flat
│  │  │  │  │  │     ├─ values-nb_values-nb.arsc.flat
│  │  │  │  │  │     ├─ values-ne_values-ne.arsc.flat
│  │  │  │  │  │     ├─ values-night-v8_values-night-v8.arsc.flat
│  │  │  │  │  │     ├─ values-nl_values-nl.arsc.flat
│  │  │  │  │  │     ├─ values-or_values-or.arsc.flat
│  │  │  │  │  │     ├─ values-pa_values-pa.arsc.flat
│  │  │  │  │  │     ├─ values-pl_values-pl.arsc.flat
│  │  │  │  │  │     ├─ values-port_values-port.arsc.flat
│  │  │  │  │  │     ├─ values-pt-rBR_values-pt-rBR.arsc.flat
│  │  │  │  │  │     ├─ values-pt-rPT_values-pt-rPT.arsc.flat
│  │  │  │  │  │     ├─ values-pt_values-pt.arsc.flat
│  │  │  │  │  │     ├─ values-ro_values-ro.arsc.flat
│  │  │  │  │  │     ├─ values-ru_values-ru.arsc.flat
│  │  │  │  │  │     ├─ values-si_values-si.arsc.flat
│  │  │  │  │  │     ├─ values-sk_values-sk.arsc.flat
│  │  │  │  │  │     ├─ values-sl_values-sl.arsc.flat
│  │  │  │  │  │     ├─ values-small-v4_values-small-v4.arsc.flat
│  │  │  │  │  │     ├─ values-sq_values-sq.arsc.flat
│  │  │  │  │  │     ├─ values-sr_values-sr.arsc.flat
│  │  │  │  │  │     ├─ values-sv_values-sv.arsc.flat
│  │  │  │  │  │     ├─ values-sw600dp-v13_values-sw600dp-v13.arsc.flat
│  │  │  │  │  │     ├─ values-sw_values-sw.arsc.flat
│  │  │  │  │  │     ├─ values-ta_values-ta.arsc.flat
│  │  │  │  │  │     ├─ values-te_values-te.arsc.flat
│  │  │  │  │  │     ├─ values-th_values-th.arsc.flat
│  │  │  │  │  │     ├─ values-tl_values-tl.arsc.flat
│  │  │  │  │  │     ├─ values-tr_values-tr.arsc.flat
│  │  │  │  │  │     ├─ values-uk_values-uk.arsc.flat
│  │  │  │  │  │     ├─ values-ur_values-ur.arsc.flat
│  │  │  │  │  │     ├─ values-uz_values-uz.arsc.flat
│  │  │  │  │  │     ├─ values-v16_values-v16.arsc.flat
│  │  │  │  │  │     ├─ values-v17_values-v17.arsc.flat
│  │  │  │  │  │     ├─ values-v18_values-v18.arsc.flat
│  │  │  │  │  │     ├─ values-v21_values-v21.arsc.flat
│  │  │  │  │  │     ├─ values-v22_values-v22.arsc.flat
│  │  │  │  │  │     ├─ values-v23_values-v23.arsc.flat
│  │  │  │  │  │     ├─ values-v24_values-v24.arsc.flat
│  │  │  │  │  │     ├─ values-v25_values-v25.arsc.flat
│  │  │  │  │  │     ├─ values-v26_values-v26.arsc.flat
│  │  │  │  │  │     ├─ values-v27_values-v27.arsc.flat
│  │  │  │  │  │     ├─ values-v28_values-v28.arsc.flat
│  │  │  │  │  │     ├─ values-v29_values-v29.arsc.flat
│  │  │  │  │  │     ├─ values-v30_values-v30.arsc.flat
│  │  │  │  │  │     ├─ values-v31_values-v31.arsc.flat
│  │  │  │  │  │     ├─ values-v34_values-v34.arsc.flat
│  │  │  │  │  │     ├─ values-vi_values-vi.arsc.flat
│  │  │  │  │  │     ├─ values-w320dp-land-v13_values-w320dp-land-v13.arsc.flat
│  │  │  │  │  │     ├─ values-w360dp-port-v13_values-w360dp-port-v13.arsc.flat
│  │  │  │  │  │     ├─ values-w400dp-port-v13_values-w400dp-port-v13.arsc.flat
│  │  │  │  │  │     ├─ values-w600dp-land-v13_values-w600dp-land-v13.arsc.flat
│  │  │  │  │  │     ├─ values-watch-v20_values-watch-v20.arsc.flat
│  │  │  │  │  │     ├─ values-watch-v21_values-watch-v21.arsc.flat
│  │  │  │  │  │     ├─ values-xlarge-v4_values-xlarge-v4.arsc.flat
│  │  │  │  │  │     ├─ values-zh-rCN_values-zh-rCN.arsc.flat
│  │  │  │  │  │     ├─ values-zh-rHK_values-zh-rHK.arsc.flat
│  │  │  │  │  │     ├─ values-zh-rTW_values-zh-rTW.arsc.flat
│  │  │  │  │  │     ├─ values-zu_values-zu.arsc.flat
│  │  │  │  │  │     ├─ values_values.arsc.flat
│  │  │  │  │  │     ├─ xml_config.xml.flat
│  │  │  │  │  │     └─ xml_file_paths.xml.flat
│  │  │  │  │  └─ release
│  │  │  │  │     └─ mergeReleaseResources
│  │  │  │  │        ├─ drawable-land-hdpi_splash.png.flat
│  │  │  │  │        ├─ drawable-land-ldpi_splash.png.flat
│  │  │  │  │        ├─ drawable-land-mdpi_splash.png.flat
│  │  │  │  │        ├─ drawable-land-xhdpi_splash.png.flat
│  │  │  │  │        ├─ drawable-land-xxhdpi_splash.png.flat
│  │  │  │  │        ├─ drawable-land-xxxhdpi_splash.png.flat
│  │  │  │  │        ├─ drawable-port-hdpi_splash.png.flat
│  │  │  │  │        ├─ drawable-port-ldpi_splash.png.flat
│  │  │  │  │        ├─ drawable-port-mdpi_splash.png.flat
│  │  │  │  │        ├─ drawable-port-xhdpi_splash.png.flat
│  │  │  │  │        ├─ drawable-port-xxhdpi_splash.png.flat
│  │  │  │  │        ├─ drawable-port-xxxhdpi_splash.png.flat
│  │  │  │  │        ├─ drawable-v24_ic_launcher_foreground.xml.flat
│  │  │  │  │        ├─ drawable_ic_launcher_background.xml.flat
│  │  │  │  │        ├─ drawable_splash.png.flat
│  │  │  │  │        ├─ layout_activity_main.xml.flat
│  │  │  │  │        ├─ mipmap-anydpi-v26_ic_launcher.xml.flat
│  │  │  │  │        ├─ mipmap-anydpi-v26_ic_launcher_round.xml.flat
│  │  │  │  │        ├─ mipmap-hdpi_ic_launcher.png.flat
│  │  │  │  │        ├─ mipmap-hdpi_ic_launcher_foreground.png.flat
│  │  │  │  │        ├─ mipmap-hdpi_ic_launcher_round.png.flat
│  │  │  │  │        ├─ mipmap-ldpi_ic_launcher.png.flat
│  │  │  │  │        ├─ mipmap-mdpi_ic_launcher.png.flat
│  │  │  │  │        ├─ mipmap-mdpi_ic_launcher_foreground.png.flat
│  │  │  │  │        ├─ mipmap-mdpi_ic_launcher_round.png.flat
│  │  │  │  │        ├─ mipmap-xhdpi_ic_launcher.png.flat
│  │  │  │  │        ├─ mipmap-xhdpi_ic_launcher_foreground.png.flat
│  │  │  │  │        ├─ mipmap-xhdpi_ic_launcher_round.png.flat
│  │  │  │  │        ├─ mipmap-xxhdpi_ic_launcher.png.flat
│  │  │  │  │        ├─ mipmap-xxhdpi_ic_launcher_foreground.png.flat
│  │  │  │  │        ├─ mipmap-xxhdpi_ic_launcher_round.png.flat
│  │  │  │  │        ├─ mipmap-xxxhdpi_ic_launcher.png.flat
│  │  │  │  │        ├─ mipmap-xxxhdpi_ic_launcher_foreground.png.flat
│  │  │  │  │        ├─ mipmap-xxxhdpi_ic_launcher_round.png.flat
│  │  │  │  │        ├─ values-af_values-af.arsc.flat
│  │  │  │  │        ├─ values-am_values-am.arsc.flat
│  │  │  │  │        ├─ values-ar_values-ar.arsc.flat
│  │  │  │  │        ├─ values-as_values-as.arsc.flat
│  │  │  │  │        ├─ values-az_values-az.arsc.flat
│  │  │  │  │        ├─ values-b+es+419_values-b+es+419.arsc.flat
│  │  │  │  │        ├─ values-b+sr+Latn_values-b+sr+Latn.arsc.flat
│  │  │  │  │        ├─ values-be_values-be.arsc.flat
│  │  │  │  │        ├─ values-bg_values-bg.arsc.flat
│  │  │  │  │        ├─ values-bn_values-bn.arsc.flat
│  │  │  │  │        ├─ values-bs_values-bs.arsc.flat
│  │  │  │  │        ├─ values-ca_values-ca.arsc.flat
│  │  │  │  │        ├─ values-cs_values-cs.arsc.flat
│  │  │  │  │        ├─ values-da_values-da.arsc.flat
│  │  │  │  │        ├─ values-de_values-de.arsc.flat
│  │  │  │  │        ├─ values-el_values-el.arsc.flat
│  │  │  │  │        ├─ values-en-rAU_values-en-rAU.arsc.flat
│  │  │  │  │        ├─ values-en-rCA_values-en-rCA.arsc.flat
│  │  │  │  │        ├─ values-en-rGB_values-en-rGB.arsc.flat
│  │  │  │  │        ├─ values-en-rIN_values-en-rIN.arsc.flat
│  │  │  │  │        ├─ values-en-rXC_values-en-rXC.arsc.flat
│  │  │  │  │        ├─ values-es-rUS_values-es-rUS.arsc.flat
│  │  │  │  │        ├─ values-es_values-es.arsc.flat
│  │  │  │  │        ├─ values-et_values-et.arsc.flat
│  │  │  │  │        ├─ values-eu_values-eu.arsc.flat
│  │  │  │  │        ├─ values-fa_values-fa.arsc.flat
│  │  │  │  │        ├─ values-fi_values-fi.arsc.flat
│  │  │  │  │        ├─ values-fr-rCA_values-fr-rCA.arsc.flat
│  │  │  │  │        ├─ values-fr_values-fr.arsc.flat
│  │  │  │  │        ├─ values-gl_values-gl.arsc.flat
│  │  │  │  │        ├─ values-gu_values-gu.arsc.flat
│  │  │  │  │        ├─ values-h320dp-port-v13_values-h320dp-port-v13.arsc.flat
│  │  │  │  │        ├─ values-h360dp-land-v13_values-h360dp-land-v13.arsc.flat
│  │  │  │  │        ├─ values-h480dp-land-v13_values-h480dp-land-v13.arsc.flat
│  │  │  │  │        ├─ values-h550dp-port-v13_values-h550dp-port-v13.arsc.flat
│  │  │  │  │        ├─ values-h720dp-v13_values-h720dp-v13.arsc.flat
│  │  │  │  │        ├─ values-hdpi-v4_values-hdpi-v4.arsc.flat
│  │  │  │  │        ├─ values-hi_values-hi.arsc.flat
│  │  │  │  │        ├─ values-hr_values-hr.arsc.flat
│  │  │  │  │        ├─ values-hu_values-hu.arsc.flat
│  │  │  │  │        ├─ values-hy_values-hy.arsc.flat
│  │  │  │  │        ├─ values-in_values-in.arsc.flat
│  │  │  │  │        ├─ values-is_values-is.arsc.flat
│  │  │  │  │        ├─ values-it_values-it.arsc.flat
│  │  │  │  │        ├─ values-iw_values-iw.arsc.flat
│  │  │  │  │        ├─ values-ja_values-ja.arsc.flat
│  │  │  │  │        ├─ values-ka_values-ka.arsc.flat
│  │  │  │  │        ├─ values-kk_values-kk.arsc.flat
│  │  │  │  │        ├─ values-km_values-km.arsc.flat
│  │  │  │  │        ├─ values-kn_values-kn.arsc.flat
│  │  │  │  │        ├─ values-ko_values-ko.arsc.flat
│  │  │  │  │        ├─ values-ky_values-ky.arsc.flat
│  │  │  │  │        ├─ values-land_values-land.arsc.flat
│  │  │  │  │        ├─ values-large-v4_values-large-v4.arsc.flat
│  │  │  │  │        ├─ values-ldltr-v21_values-ldltr-v21.arsc.flat
│  │  │  │  │        ├─ values-ldrtl-v17_values-ldrtl-v17.arsc.flat
│  │  │  │  │        ├─ values-lo_values-lo.arsc.flat
│  │  │  │  │        ├─ values-lt_values-lt.arsc.flat
│  │  │  │  │        ├─ values-lv_values-lv.arsc.flat
│  │  │  │  │        ├─ values-mk_values-mk.arsc.flat
│  │  │  │  │        ├─ values-ml_values-ml.arsc.flat
│  │  │  │  │        ├─ values-mn_values-mn.arsc.flat
│  │  │  │  │        ├─ values-mr_values-mr.arsc.flat
│  │  │  │  │        ├─ values-ms_values-ms.arsc.flat
│  │  │  │  │        ├─ values-my_values-my.arsc.flat
│  │  │  │  │        ├─ values-nb_values-nb.arsc.flat
│  │  │  │  │        ├─ values-ne_values-ne.arsc.flat
│  │  │  │  │        ├─ values-night-v8_values-night-v8.arsc.flat
│  │  │  │  │        ├─ values-nl_values-nl.arsc.flat
│  │  │  │  │        ├─ values-or_values-or.arsc.flat
│  │  │  │  │        ├─ values-pa_values-pa.arsc.flat
│  │  │  │  │        ├─ values-pl_values-pl.arsc.flat
│  │  │  │  │        ├─ values-port_values-port.arsc.flat
│  │  │  │  │        ├─ values-pt-rBR_values-pt-rBR.arsc.flat
│  │  │  │  │        ├─ values-pt-rPT_values-pt-rPT.arsc.flat
│  │  │  │  │        ├─ values-pt_values-pt.arsc.flat
│  │  │  │  │        ├─ values-ro_values-ro.arsc.flat
│  │  │  │  │        ├─ values-ru_values-ru.arsc.flat
│  │  │  │  │        ├─ values-si_values-si.arsc.flat
│  │  │  │  │        ├─ values-sk_values-sk.arsc.flat
│  │  │  │  │        ├─ values-sl_values-sl.arsc.flat
│  │  │  │  │        ├─ values-small-v4_values-small-v4.arsc.flat
│  │  │  │  │        ├─ values-sq_values-sq.arsc.flat
│  │  │  │  │        ├─ values-sr_values-sr.arsc.flat
│  │  │  │  │        ├─ values-sv_values-sv.arsc.flat
│  │  │  │  │        ├─ values-sw600dp-v13_values-sw600dp-v13.arsc.flat
│  │  │  │  │        ├─ values-sw_values-sw.arsc.flat
│  │  │  │  │        ├─ values-ta_values-ta.arsc.flat
│  │  │  │  │        ├─ values-te_values-te.arsc.flat
│  │  │  │  │        ├─ values-th_values-th.arsc.flat
│  │  │  │  │        ├─ values-tl_values-tl.arsc.flat
│  │  │  │  │        ├─ values-tr_values-tr.arsc.flat
│  │  │  │  │        ├─ values-uk_values-uk.arsc.flat
│  │  │  │  │        ├─ values-ur_values-ur.arsc.flat
│  │  │  │  │        ├─ values-uz_values-uz.arsc.flat
│  │  │  │  │        ├─ values-v16_values-v16.arsc.flat
│  │  │  │  │        ├─ values-v17_values-v17.arsc.flat
│  │  │  │  │        ├─ values-v18_values-v18.arsc.flat
│  │  │  │  │        ├─ values-v21_values-v21.arsc.flat
│  │  │  │  │        ├─ values-v22_values-v22.arsc.flat
│  │  │  │  │        ├─ values-v23_values-v23.arsc.flat
│  │  │  │  │        ├─ values-v24_values-v24.arsc.flat
│  │  │  │  │        ├─ values-v25_values-v25.arsc.flat
│  │  │  │  │        ├─ values-v26_values-v26.arsc.flat
│  │  │  │  │        ├─ values-v27_values-v27.arsc.flat
│  │  │  │  │        ├─ values-v28_values-v28.arsc.flat
│  │  │  │  │        ├─ values-v29_values-v29.arsc.flat
│  │  │  │  │        ├─ values-v30_values-v30.arsc.flat
│  │  │  │  │        ├─ values-v31_values-v31.arsc.flat
│  │  │  │  │        ├─ values-v34_values-v34.arsc.flat
│  │  │  │  │        ├─ values-vi_values-vi.arsc.flat
│  │  │  │  │        ├─ values-w320dp-land-v13_values-w320dp-land-v13.arsc.flat
│  │  │  │  │        ├─ values-w360dp-port-v13_values-w360dp-port-v13.arsc.flat
│  │  │  │  │        ├─ values-w400dp-port-v13_values-w400dp-port-v13.arsc.flat
│  │  │  │  │        ├─ values-w600dp-land-v13_values-w600dp-land-v13.arsc.flat
│  │  │  │  │        ├─ values-watch-v20_values-watch-v20.arsc.flat
│  │  │  │  │        ├─ values-watch-v21_values-watch-v21.arsc.flat
│  │  │  │  │        ├─ values-xlarge-v4_values-xlarge-v4.arsc.flat
│  │  │  │  │        ├─ values-zh-rCN_values-zh-rCN.arsc.flat
│  │  │  │  │        ├─ values-zh-rHK_values-zh-rHK.arsc.flat
│  │  │  │  │        ├─ values-zh-rTW_values-zh-rTW.arsc.flat
│  │  │  │  │        ├─ values-zu_values-zu.arsc.flat
│  │  │  │  │        ├─ values_values.arsc.flat
│  │  │  │  │        ├─ xml_config.xml.flat
│  │  │  │  │        └─ xml_file_paths.xml.flat
│  │  │  │  ├─ merged_res_blame_folder
│  │  │  │  │  ├─ debug
│  │  │  │  │  │  └─ mergeDebugResources
│  │  │  │  │  │     └─ out
│  │  │  │  │  │        ├─ multi-v2
│  │  │  │  │  │        │  ├─ mergeDebugResources.json
│  │  │  │  │  │        │  ├─ values-af.json
│  │  │  │  │  │        │  ├─ values-am.json
│  │  │  │  │  │        │  ├─ values-ar.json
│  │  │  │  │  │        │  ├─ values-as.json
│  │  │  │  │  │        │  ├─ values-az.json
│  │  │  │  │  │        │  ├─ values-b+es+419.json
│  │  │  │  │  │        │  ├─ values-b+sr+Latn.json
│  │  │  │  │  │        │  ├─ values-be.json
│  │  │  │  │  │        │  ├─ values-bg.json
│  │  │  │  │  │        │  ├─ values-bn.json
│  │  │  │  │  │        │  ├─ values-bs.json
│  │  │  │  │  │        │  ├─ values-ca.json
│  │  │  │  │  │        │  ├─ values-cs.json
│  │  │  │  │  │        │  ├─ values-da.json
│  │  │  │  │  │        │  ├─ values-de.json
│  │  │  │  │  │        │  ├─ values-el.json
│  │  │  │  │  │        │  ├─ values-en-rAU.json
│  │  │  │  │  │        │  ├─ values-en-rCA.json
│  │  │  │  │  │        │  ├─ values-en-rGB.json
│  │  │  │  │  │        │  ├─ values-en-rIN.json
│  │  │  │  │  │        │  ├─ values-en-rXC.json
│  │  │  │  │  │        │  ├─ values-es-rUS.json
│  │  │  │  │  │        │  ├─ values-es.json
│  │  │  │  │  │        │  ├─ values-et.json
│  │  │  │  │  │        │  ├─ values-eu.json
│  │  │  │  │  │        │  ├─ values-fa.json
│  │  │  │  │  │        │  ├─ values-fi.json
│  │  │  │  │  │        │  ├─ values-fr-rCA.json
│  │  │  │  │  │        │  ├─ values-fr.json
│  │  │  │  │  │        │  ├─ values-gl.json
│  │  │  │  │  │        │  ├─ values-gu.json
│  │  │  │  │  │        │  ├─ values-h320dp-port-v13.json
│  │  │  │  │  │        │  ├─ values-h360dp-land-v13.json
│  │  │  │  │  │        │  ├─ values-h480dp-land-v13.json
│  │  │  │  │  │        │  ├─ values-h550dp-port-v13.json
│  │  │  │  │  │        │  ├─ values-h720dp-v13.json
│  │  │  │  │  │        │  ├─ values-hdpi-v4.json
│  │  │  │  │  │        │  ├─ values-hi.json
│  │  │  │  │  │        │  ├─ values-hr.json
│  │  │  │  │  │        │  ├─ values-hu.json
│  │  │  │  │  │        │  ├─ values-hy.json
│  │  │  │  │  │        │  ├─ values-in.json
│  │  │  │  │  │        │  ├─ values-is.json
│  │  │  │  │  │        │  ├─ values-it.json
│  │  │  │  │  │        │  ├─ values-iw.json
│  │  │  │  │  │        │  ├─ values-ja.json
│  │  │  │  │  │        │  ├─ values-ka.json
│  │  │  │  │  │        │  ├─ values-kk.json
│  │  │  │  │  │        │  ├─ values-km.json
│  │  │  │  │  │        │  ├─ values-kn.json
│  │  │  │  │  │        │  ├─ values-ko.json
│  │  │  │  │  │        │  ├─ values-ky.json
│  │  │  │  │  │        │  ├─ values-land.json
│  │  │  │  │  │        │  ├─ values-large-v4.json
│  │  │  │  │  │        │  ├─ values-ldltr-v21.json
│  │  │  │  │  │        │  ├─ values-ldrtl-v17.json
│  │  │  │  │  │        │  ├─ values-lo.json
│  │  │  │  │  │        │  ├─ values-lt.json
│  │  │  │  │  │        │  ├─ values-lv.json
│  │  │  │  │  │        │  ├─ values-mk.json
│  │  │  │  │  │        │  ├─ values-ml.json
│  │  │  │  │  │        │  ├─ values-mn.json
│  │  │  │  │  │        │  ├─ values-mr.json
│  │  │  │  │  │        │  ├─ values-ms.json
│  │  │  │  │  │        │  ├─ values-my.json
│  │  │  │  │  │        │  ├─ values-nb.json
│  │  │  │  │  │        │  ├─ values-ne.json
│  │  │  │  │  │        │  ├─ values-night-v8.json
│  │  │  │  │  │        │  ├─ values-nl.json
│  │  │  │  │  │        │  ├─ values-or.json
│  │  │  │  │  │        │  ├─ values-pa.json
│  │  │  │  │  │        │  ├─ values-pl.json
│  │  │  │  │  │        │  ├─ values-port.json
│  │  │  │  │  │        │  ├─ values-pt-rBR.json
│  │  │  │  │  │        │  ├─ values-pt-rPT.json
│  │  │  │  │  │        │  ├─ values-pt.json
│  │  │  │  │  │        │  ├─ values-ro.json
│  │  │  │  │  │        │  ├─ values-ru.json
│  │  │  │  │  │        │  ├─ values-si.json
│  │  │  │  │  │        │  ├─ values-sk.json
│  │  │  │  │  │        │  ├─ values-sl.json
│  │  │  │  │  │        │  ├─ values-small-v4.json
│  │  │  │  │  │        │  ├─ values-sq.json
│  │  │  │  │  │        │  ├─ values-sr.json
│  │  │  │  │  │        │  ├─ values-sv.json
│  │  │  │  │  │        │  ├─ values-sw.json
│  │  │  │  │  │        │  ├─ values-sw600dp-v13.json
│  │  │  │  │  │        │  ├─ values-ta.json
│  │  │  │  │  │        │  ├─ values-te.json
│  │  │  │  │  │        │  ├─ values-th.json
│  │  │  │  │  │        │  ├─ values-tl.json
│  │  │  │  │  │        │  ├─ values-tr.json
│  │  │  │  │  │        │  ├─ values-uk.json
│  │  │  │  │  │        │  ├─ values-ur.json
│  │  │  │  │  │        │  ├─ values-uz.json
│  │  │  │  │  │        │  ├─ values-v16.json
│  │  │  │  │  │        │  ├─ values-v17.json
│  │  │  │  │  │        │  ├─ values-v18.json
│  │  │  │  │  │        │  ├─ values-v21.json
│  │  │  │  │  │        │  ├─ values-v22.json
│  │  │  │  │  │        │  ├─ values-v23.json
│  │  │  │  │  │        │  ├─ values-v24.json
│  │  │  │  │  │        │  ├─ values-v25.json
│  │  │  │  │  │        │  ├─ values-v26.json
│  │  │  │  │  │        │  ├─ values-v27.json
│  │  │  │  │  │        │  ├─ values-v28.json
│  │  │  │  │  │        │  ├─ values-v29.json
│  │  │  │  │  │        │  ├─ values-v30.json
│  │  │  │  │  │        │  ├─ values-v31.json
│  │  │  │  │  │        │  ├─ values-v34.json
│  │  │  │  │  │        │  ├─ values-vi.json
│  │  │  │  │  │        │  ├─ values-w320dp-land-v13.json
│  │  │  │  │  │        │  ├─ values-w360dp-port-v13.json
│  │  │  │  │  │        │  ├─ values-w400dp-port-v13.json
│  │  │  │  │  │        │  ├─ values-w600dp-land-v13.json
│  │  │  │  │  │        │  ├─ values-watch-v20.json
│  │  │  │  │  │        │  ├─ values-watch-v21.json
│  │  │  │  │  │        │  ├─ values-xlarge-v4.json
│  │  │  │  │  │        │  ├─ values-zh-rCN.json
│  │  │  │  │  │        │  ├─ values-zh-rHK.json
│  │  │  │  │  │        │  ├─ values-zh-rTW.json
│  │  │  │  │  │        │  ├─ values-zu.json
│  │  │  │  │  │        │  └─ values.json
│  │  │  │  │  │        └─ single
│  │  │  │  │  │           └─ mergeDebugResources.json
│  │  │  │  │  └─ release
│  │  │  │  │     └─ mergeReleaseResources
│  │  │  │  │        └─ out
│  │  │  │  │           ├─ multi-v2
│  │  │  │  │           │  ├─ mergeReleaseResources.json
│  │  │  │  │           │  ├─ values-af.json
│  │  │  │  │           │  ├─ values-am.json
│  │  │  │  │           │  ├─ values-ar.json
│  │  │  │  │           │  ├─ values-as.json
│  │  │  │  │           │  ├─ values-az.json
│  │  │  │  │           │  ├─ values-b+es+419.json
│  │  │  │  │           │  ├─ values-b+sr+Latn.json
│  │  │  │  │           │  ├─ values-be.json
│  │  │  │  │           │  ├─ values-bg.json
│  │  │  │  │           │  ├─ values-bn.json
│  │  │  │  │           │  ├─ values-bs.json
│  │  │  │  │           │  ├─ values-ca.json
│  │  │  │  │           │  ├─ values-cs.json
│  │  │  │  │           │  ├─ values-da.json
│  │  │  │  │           │  ├─ values-de.json
│  │  │  │  │           │  ├─ values-el.json
│  │  │  │  │           │  ├─ values-en-rAU.json
│  │  │  │  │           │  ├─ values-en-rCA.json
│  │  │  │  │           │  ├─ values-en-rGB.json
│  │  │  │  │           │  ├─ values-en-rIN.json
│  │  │  │  │           │  ├─ values-en-rXC.json
│  │  │  │  │           │  ├─ values-es-rUS.json
│  │  │  │  │           │  ├─ values-es.json
│  │  │  │  │           │  ├─ values-et.json
│  │  │  │  │           │  ├─ values-eu.json
│  │  │  │  │           │  ├─ values-fa.json
│  │  │  │  │           │  ├─ values-fi.json
│  │  │  │  │           │  ├─ values-fr-rCA.json
│  │  │  │  │           │  ├─ values-fr.json
│  │  │  │  │           │  ├─ values-gl.json
│  │  │  │  │           │  ├─ values-gu.json
│  │  │  │  │           │  ├─ values-h320dp-port-v13.json
│  │  │  │  │           │  ├─ values-h360dp-land-v13.json
│  │  │  │  │           │  ├─ values-h480dp-land-v13.json
│  │  │  │  │           │  ├─ values-h550dp-port-v13.json
│  │  │  │  │           │  ├─ values-h720dp-v13.json
│  │  │  │  │           │  ├─ values-hdpi-v4.json
│  │  │  │  │           │  ├─ values-hi.json
│  │  │  │  │           │  ├─ values-hr.json
│  │  │  │  │           │  ├─ values-hu.json
│  │  │  │  │           │  ├─ values-hy.json
│  │  │  │  │           │  ├─ values-in.json
│  │  │  │  │           │  ├─ values-is.json
│  │  │  │  │           │  ├─ values-it.json
│  │  │  │  │           │  ├─ values-iw.json
│  │  │  │  │           │  ├─ values-ja.json
│  │  │  │  │           │  ├─ values-ka.json
│  │  │  │  │           │  ├─ values-kk.json
│  │  │  │  │           │  ├─ values-km.json
│  │  │  │  │           │  ├─ values-kn.json
│  │  │  │  │           │  ├─ values-ko.json
│  │  │  │  │           │  ├─ values-ky.json
│  │  │  │  │           │  ├─ values-land.json
│  │  │  │  │           │  ├─ values-large-v4.json
│  │  │  │  │           │  ├─ values-ldltr-v21.json
│  │  │  │  │           │  ├─ values-ldrtl-v17.json
│  │  │  │  │           │  ├─ values-lo.json
│  │  │  │  │           │  ├─ values-lt.json
│  │  │  │  │           │  ├─ values-lv.json
│  │  │  │  │           │  ├─ values-mk.json
│  │  │  │  │           │  ├─ values-ml.json
│  │  │  │  │           │  ├─ values-mn.json
│  │  │  │  │           │  ├─ values-mr.json
│  │  │  │  │           │  ├─ values-ms.json
│  │  │  │  │           │  ├─ values-my.json
│  │  │  │  │           │  ├─ values-nb.json
│  │  │  │  │           │  ├─ values-ne.json
│  │  │  │  │           │  ├─ values-night-v8.json
│  │  │  │  │           │  ├─ values-nl.json
│  │  │  │  │           │  ├─ values-or.json
│  │  │  │  │           │  ├─ values-pa.json
│  │  │  │  │           │  ├─ values-pl.json
│  │  │  │  │           │  ├─ values-port.json
│  │  │  │  │           │  ├─ values-pt-rBR.json
│  │  │  │  │           │  ├─ values-pt-rPT.json
│  │  │  │  │           │  ├─ values-pt.json
│  │  │  │  │           │  ├─ values-ro.json
│  │  │  │  │           │  ├─ values-ru.json
│  │  │  │  │           │  ├─ values-si.json
│  │  │  │  │           │  ├─ values-sk.json
│  │  │  │  │           │  ├─ values-sl.json
│  │  │  │  │           │  ├─ values-small-v4.json
│  │  │  │  │           │  ├─ values-sq.json
│  │  │  │  │           │  ├─ values-sr.json
│  │  │  │  │           │  ├─ values-sv.json
│  │  │  │  │           │  ├─ values-sw.json
│  │  │  │  │           │  ├─ values-sw600dp-v13.json
│  │  │  │  │           │  ├─ values-ta.json
│  │  │  │  │           │  ├─ values-te.json
│  │  │  │  │           │  ├─ values-th.json
│  │  │  │  │           │  ├─ values-tl.json
│  │  │  │  │           │  ├─ values-tr.json
│  │  │  │  │           │  ├─ values-uk.json
│  │  │  │  │           │  ├─ values-ur.json
│  │  │  │  │           │  ├─ values-uz.json
│  │  │  │  │           │  ├─ values-v16.json
│  │  │  │  │           │  ├─ values-v17.json
│  │  │  │  │           │  ├─ values-v18.json
│  │  │  │  │           │  ├─ values-v21.json
│  │  │  │  │           │  ├─ values-v22.json
│  │  │  │  │           │  ├─ values-v23.json
│  │  │  │  │           │  ├─ values-v24.json
│  │  │  │  │           │  ├─ values-v25.json
│  │  │  │  │           │  ├─ values-v26.json
│  │  │  │  │           │  ├─ values-v27.json
│  │  │  │  │           │  ├─ values-v28.json
│  │  │  │  │           │  ├─ values-v29.json
│  │  │  │  │           │  ├─ values-v30.json
│  │  │  │  │           │  ├─ values-v31.json
│  │  │  │  │           │  ├─ values-v34.json
│  │  │  │  │           │  ├─ values-vi.json
│  │  │  │  │           │  ├─ values-w320dp-land-v13.json
│  │  │  │  │           │  ├─ values-w360dp-port-v13.json
│  │  │  │  │           │  ├─ values-w400dp-port-v13.json
│  │  │  │  │           │  ├─ values-w600dp-land-v13.json
│  │  │  │  │           │  ├─ values-watch-v20.json
│  │  │  │  │           │  ├─ values-watch-v21.json
│  │  │  │  │           │  ├─ values-xlarge-v4.json
│  │  │  │  │           │  ├─ values-zh-rCN.json
│  │  │  │  │           │  ├─ values-zh-rHK.json
│  │  │  │  │           │  ├─ values-zh-rTW.json
│  │  │  │  │           │  ├─ values-zu.json
│  │  │  │  │           │  └─ values.json
│  │  │  │  │           └─ single
│  │  │  │  │              └─ mergeReleaseResources.json
│  │  │  │  ├─ merged_shaders
│  │  │  │  │  ├─ debug
│  │  │  │  │  │  └─ mergeDebugShaders
│  │  │  │  │  │     └─ out
│  │  │  │  │  └─ release
│  │  │  │  │     └─ mergeReleaseShaders
│  │  │  │  │        └─ out
│  │  │  │  ├─ merged_startup_profile
│  │  │  │  │  └─ release
│  │  │  │  │     └─ mergeReleaseStartupProfile
│  │  │  │  ├─ merged_test_only_native_libs
│  │  │  │  │  ├─ debug
│  │  │  │  │  │  └─ mergeDebugNativeLibs
│  │  │  │  │  │     └─ out
│  │  │  │  │  └─ release
│  │  │  │  │     └─ mergeReleaseNativeLibs
│  │  │  │  │        └─ out
│  │  │  │  ├─ metadata_library_dependencies_report
│  │  │  │  │  └─ release
│  │  │  │  │     └─ collectReleaseDependencies
│  │  │  │  │        └─ dependencies.pb
│  │  │  │  ├─ mixed_scope_dex_archive
│  │  │  │  │  ├─ debug
│  │  │  │  │  │  └─ dexBuilderDebug
│  │  │  │  │  │     └─ out
│  │  │  │  │  └─ release
│  │  │  │  │     └─ dexBuilderRelease
│  │  │  │  │        └─ out
│  │  │  │  ├─ module_bundle
│  │  │  │  │  └─ release
│  │  │  │  │     └─ buildReleasePreBundle
│  │  │  │  │        └─ base.zip
│  │  │  │  ├─ native_symbol_tables
│  │  │  │  │  └─ release
│  │  │  │  │     └─ extractReleaseNativeSymbolTables
│  │  │  │  │        └─ out
│  │  │  │  ├─ navigation_json
│  │  │  │  │  ├─ debug
│  │  │  │  │  │  └─ extractDeepLinksDebug
│  │  │  │  │  │     └─ navigation.json
│  │  │  │  │  └─ release
│  │  │  │  │     └─ extractDeepLinksRelease
│  │  │  │  │        └─ navigation.json
│  │  │  │  ├─ nested_resources_validation_report
│  │  │  │  │  ├─ debug
│  │  │  │  │  │  └─ generateDebugResources
│  │  │  │  │  │     └─ nestedResourcesValidationReport.txt
│  │  │  │  │  └─ release
│  │  │  │  │     └─ generateReleaseResources
│  │  │  │  │        └─ nestedResourcesValidationReport.txt
│  │  │  │  ├─ optimized_processed_res
│  │  │  │  │  └─ release
│  │  │  │  │     └─ optimizeReleaseResources
│  │  │  │  │        ├─ output-metadata.json
│  │  │  │  │        └─ resources-release-optimize.ap_
│  │  │  │  ├─ packaged_manifests
│  │  │  │  │  ├─ debug
│  │  │  │  │  │  └─ processDebugManifestForPackage
│  │  │  │  │  │     ├─ AndroidManifest.xml
│  │  │  │  │  │     └─ output-metadata.json
│  │  │  │  │  └─ release
│  │  │  │  │     └─ processReleaseManifestForPackage
│  │  │  │  │        ├─ AndroidManifest.xml
│  │  │  │  │        └─ output-metadata.json
│  │  │  │  ├─ packaged_res
│  │  │  │  │  ├─ debug
│  │  │  │  │  │  └─ packageDebugResources
│  │  │  │  │  │     ├─ drawable
│  │  │  │  │  │     │  ├─ ic_launcher_background.xml
│  │  │  │  │  │     │  └─ splash.png
│  │  │  │  │  │     ├─ drawable-land-hdpi-v4
│  │  │  │  │  │     │  └─ splash.png
│  │  │  │  │  │     ├─ drawable-land-ldpi-v4
│  │  │  │  │  │     │  └─ splash.png
│  │  │  │  │  │     ├─ drawable-land-mdpi-v4
│  │  │  │  │  │     │  └─ splash.png
│  │  │  │  │  │     ├─ drawable-land-xhdpi-v4
│  │  │  │  │  │     │  └─ splash.png
│  │  │  │  │  │     ├─ drawable-land-xxhdpi-v4
│  │  │  │  │  │     │  └─ splash.png
│  │  │  │  │  │     ├─ drawable-land-xxxhdpi-v4
│  │  │  │  │  │     │  └─ splash.png
│  │  │  │  │  │     ├─ drawable-port-hdpi-v4
│  │  │  │  │  │     │  └─ splash.png
│  │  │  │  │  │     ├─ drawable-port-ldpi-v4
│  │  │  │  │  │     │  └─ splash.png
│  │  │  │  │  │     ├─ drawable-port-mdpi-v4
│  │  │  │  │  │     │  └─ splash.png
│  │  │  │  │  │     ├─ drawable-port-xhdpi-v4
│  │  │  │  │  │     │  └─ splash.png
│  │  │  │  │  │     ├─ drawable-port-xxhdpi-v4
│  │  │  │  │  │     │  └─ splash.png
│  │  │  │  │  │     ├─ drawable-port-xxxhdpi-v4
│  │  │  │  │  │     │  └─ splash.png
│  │  │  │  │  │     ├─ drawable-v24
│  │  │  │  │  │     │  └─ ic_launcher_foreground.xml
│  │  │  │  │  │     ├─ layout
│  │  │  │  │  │     │  └─ activity_main.xml
│  │  │  │  │  │     ├─ mipmap-anydpi-v26
│  │  │  │  │  │     │  ├─ ic_launcher.xml
│  │  │  │  │  │     │  └─ ic_launcher_round.xml
│  │  │  │  │  │     ├─ mipmap-hdpi-v4
│  │  │  │  │  │     │  ├─ ic_launcher.png
│  │  │  │  │  │     │  ├─ ic_launcher_foreground.png
│  │  │  │  │  │     │  └─ ic_launcher_round.png
│  │  │  │  │  │     ├─ mipmap-ldpi-v4
│  │  │  │  │  │     │  └─ ic_launcher.png
│  │  │  │  │  │     ├─ mipmap-mdpi-v4
│  │  │  │  │  │     │  ├─ ic_launcher.png
│  │  │  │  │  │     │  ├─ ic_launcher_foreground.png
│  │  │  │  │  │     │  └─ ic_launcher_round.png
│  │  │  │  │  │     ├─ mipmap-xhdpi-v4
│  │  │  │  │  │     │  ├─ ic_launcher.png
│  │  │  │  │  │     │  ├─ ic_launcher_foreground.png
│  │  │  │  │  │     │  └─ ic_launcher_round.png
│  │  │  │  │  │     ├─ mipmap-xxhdpi-v4
│  │  │  │  │  │     │  ├─ ic_launcher.png
│  │  │  │  │  │     │  ├─ ic_launcher_foreground.png
│  │  │  │  │  │     │  └─ ic_launcher_round.png
│  │  │  │  │  │     ├─ mipmap-xxxhdpi-v4
│  │  │  │  │  │     │  ├─ ic_launcher.png
│  │  │  │  │  │     │  ├─ ic_launcher_foreground.png
│  │  │  │  │  │     │  └─ ic_launcher_round.png
│  │  │  │  │  │     ├─ values
│  │  │  │  │  │     │  └─ values.xml
│  │  │  │  │  │     └─ xml
│  │  │  │  │  │        ├─ config.xml
│  │  │  │  │  │        └─ file_paths.xml
│  │  │  │  │  └─ release
│  │  │  │  │     └─ packageReleaseResources
│  │  │  │  │        ├─ drawable
│  │  │  │  │        │  ├─ ic_launcher_background.xml
│  │  │  │  │        │  └─ splash.png
│  │  │  │  │        ├─ drawable-land-hdpi-v4
│  │  │  │  │        │  └─ splash.png
│  │  │  │  │        ├─ drawable-land-ldpi-v4
│  │  │  │  │        │  └─ splash.png
│  │  │  │  │        ├─ drawable-land-mdpi-v4
│  │  │  │  │        │  └─ splash.png
│  │  │  │  │        ├─ drawable-land-xhdpi-v4
│  │  │  │  │        │  └─ splash.png
│  │  │  │  │        ├─ drawable-land-xxhdpi-v4
│  │  │  │  │        │  └─ splash.png
│  │  │  │  │        ├─ drawable-land-xxxhdpi-v4
│  │  │  │  │        │  └─ splash.png
│  │  │  │  │        ├─ drawable-port-hdpi-v4
│  │  │  │  │        │  └─ splash.png
│  │  │  │  │        ├─ drawable-port-ldpi-v4
│  │  │  │  │        │  └─ splash.png
│  │  │  │  │        ├─ drawable-port-mdpi-v4
│  │  │  │  │        │  └─ splash.png
│  │  │  │  │        ├─ drawable-port-xhdpi-v4
│  │  │  │  │        │  └─ splash.png
│  │  │  │  │        ├─ drawable-port-xxhdpi-v4
│  │  │  │  │        │  └─ splash.png
│  │  │  │  │        ├─ drawable-port-xxxhdpi-v4
│  │  │  │  │        │  └─ splash.png
│  │  │  │  │        ├─ drawable-v24
│  │  │  │  │        │  └─ ic_launcher_foreground.xml
│  │  │  │  │        ├─ layout
│  │  │  │  │        │  └─ activity_main.xml
│  │  │  │  │        ├─ mipmap-anydpi-v26
│  │  │  │  │        │  ├─ ic_launcher.xml
│  │  │  │  │        │  └─ ic_launcher_round.xml
│  │  │  │  │        ├─ mipmap-hdpi-v4
│  │  │  │  │        │  ├─ ic_launcher.png
│  │  │  │  │        │  ├─ ic_launcher_foreground.png
│  │  │  │  │        │  └─ ic_launcher_round.png
│  │  │  │  │        ├─ mipmap-ldpi-v4
│  │  │  │  │        │  └─ ic_launcher.png
│  │  │  │  │        ├─ mipmap-mdpi-v4
│  │  │  │  │        │  ├─ ic_launcher.png
│  │  │  │  │        │  ├─ ic_launcher_foreground.png
│  │  │  │  │        │  └─ ic_launcher_round.png
│  │  │  │  │        ├─ mipmap-xhdpi-v4
│  │  │  │  │        │  ├─ ic_launcher.png
│  │  │  │  │        │  ├─ ic_launcher_foreground.png
│  │  │  │  │        │  └─ ic_launcher_round.png
│  │  │  │  │        ├─ mipmap-xxhdpi-v4
│  │  │  │  │        │  ├─ ic_launcher.png
│  │  │  │  │        │  ├─ ic_launcher_foreground.png
│  │  │  │  │        │  └─ ic_launcher_round.png
│  │  │  │  │        ├─ mipmap-xxxhdpi-v4
│  │  │  │  │        │  ├─ ic_launcher.png
│  │  │  │  │        │  ├─ ic_launcher_foreground.png
│  │  │  │  │        │  └─ ic_launcher_round.png
│  │  │  │  │        ├─ values
│  │  │  │  │        │  └─ values.xml
│  │  │  │  │        └─ xml
│  │  │  │  │           ├─ config.xml
│  │  │  │  │           └─ file_paths.xml
│  │  │  │  ├─ project_dex_archive
│  │  │  │  │  ├─ debug
│  │  │  │  │  │  └─ dexBuilderDebug
│  │  │  │  │  │     └─ out
│  │  │  │  │  │        ├─ a22e145830fc79e5d5def4b72960a9c080c56c599fbda69e4fcc9918be737d8c_0.jar
│  │  │  │  │  │        ├─ a22e145830fc79e5d5def4b72960a9c080c56c599fbda69e4fcc9918be737d8c_1.jar
│  │  │  │  │  │        ├─ a22e145830fc79e5d5def4b72960a9c080c56c599fbda69e4fcc9918be737d8c_2.jar
│  │  │  │  │  │        └─ optn
│  │  │  │  │  │           └─ wallet
│  │  │  │  │  │              └─ app
│  │  │  │  │  │                 └─ MainActivity.dex
│  │  │  │  │  └─ release
│  │  │  │  │     └─ dexBuilderRelease
│  │  │  │  │        └─ out
│  │  │  │  │           ├─ a22e145830fc79e5d5def4b72960a9c080c56c599fbda69e4fcc9918be737d8c_0.jar
│  │  │  │  │           ├─ a22e145830fc79e5d5def4b72960a9c080c56c599fbda69e4fcc9918be737d8c_1.jar
│  │  │  │  │           ├─ a22e145830fc79e5d5def4b72960a9c080c56c599fbda69e4fcc9918be737d8c_2.jar
│  │  │  │  │           └─ optn
│  │  │  │  │              └─ wallet
│  │  │  │  │                 └─ app
│  │  │  │  │                    └─ MainActivity.dex
│  │  │  │  ├─ runtime_symbol_list
│  │  │  │  │  ├─ debug
│  │  │  │  │  │  └─ processDebugResources
│  │  │  │  │  │     └─ R.txt
│  │  │  │  │  └─ release
│  │  │  │  │     └─ processReleaseResources
│  │  │  │  │        └─ R.txt
│  │  │  │  ├─ sdk_dependency_data
│  │  │  │  │  └─ release
│  │  │  │  │     └─ sdkReleaseDependencyData
│  │  │  │  │        └─ sdkDependencyData.pb
│  │  │  │  ├─ signing_config_versions
│  │  │  │  │  ├─ debug
│  │  │  │  │  │  └─ writeDebugSigningConfigVersions
│  │  │  │  │  │     └─ signing-config-versions.json
│  │  │  │  │  └─ release
│  │  │  │  │     └─ writeReleaseSigningConfigVersions
│  │  │  │  │        └─ signing-config-versions.json
│  │  │  │  ├─ source_set_path_map
│  │  │  │  │  ├─ debug
│  │  │  │  │  │  └─ mapDebugSourceSetPaths
│  │  │  │  │  │     └─ file-map.txt
│  │  │  │  │  └─ release
│  │  │  │  │     └─ mapReleaseSourceSetPaths
│  │  │  │  │        └─ file-map.txt
│  │  │  │  ├─ stable_resource_ids_file
│  │  │  │  │  ├─ debug
│  │  │  │  │  │  └─ processDebugResources
│  │  │  │  │  │     └─ stableIds.txt
│  │  │  │  │  └─ release
│  │  │  │  │     └─ processReleaseResources
│  │  │  │  │        └─ stableIds.txt
│  │  │  │  ├─ stripped_native_libs
│  │  │  │  │  ├─ debug
│  │  │  │  │  │  └─ stripDebugDebugSymbols
│  │  │  │  │  │     └─ out
│  │  │  │  │  │        └─ lib
│  │  │  │  │  │           ├─ arm64-v8a
│  │  │  │  │  │           │  ├─ libandroidx.graphics.path.so
│  │  │  │  │  │           │  ├─ libbarhopper_v3.so
│  │  │  │  │  │           │  └─ libimage_processing_util_jni.so
│  │  │  │  │  │           ├─ armeabi-v7a
│  │  │  │  │  │           │  ├─ libandroidx.graphics.path.so
│  │  │  │  │  │           │  ├─ libbarhopper_v3.so
│  │  │  │  │  │           │  └─ libimage_processing_util_jni.so
│  │  │  │  │  │           ├─ x86
│  │  │  │  │  │           │  ├─ libandroidx.graphics.path.so
│  │  │  │  │  │           │  ├─ libbarhopper_v3.so
│  │  │  │  │  │           │  └─ libimage_processing_util_jni.so
│  │  │  │  │  │           └─ x86_64
│  │  │  │  │  │              ├─ libandroidx.graphics.path.so
│  │  │  │  │  │              ├─ libbarhopper_v3.so
│  │  │  │  │  │              └─ libimage_processing_util_jni.so
│  │  │  │  │  └─ release
│  │  │  │  │     └─ stripReleaseDebugSymbols
│  │  │  │  │        └─ out
│  │  │  │  │           └─ lib
│  │  │  │  │              ├─ arm64-v8a
│  │  │  │  │              │  ├─ libandroidx.graphics.path.so
│  │  │  │  │              │  ├─ libbarhopper_v3.so
│  │  │  │  │              │  └─ libimage_processing_util_jni.so
│  │  │  │  │              ├─ armeabi-v7a
│  │  │  │  │              │  ├─ libandroidx.graphics.path.so
│  │  │  │  │              │  ├─ libbarhopper_v3.so
│  │  │  │  │              │  └─ libimage_processing_util_jni.so
│  │  │  │  │              ├─ x86
│  │  │  │  │              │  ├─ libandroidx.graphics.path.so
│  │  │  │  │              │  ├─ libbarhopper_v3.so
│  │  │  │  │              │  └─ libimage_processing_util_jni.so
│  │  │  │  │              └─ x86_64
│  │  │  │  │                 ├─ libandroidx.graphics.path.so
│  │  │  │  │                 ├─ libbarhopper_v3.so
│  │  │  │  │                 └─ libimage_processing_util_jni.so
│  │  │  │  ├─ sub_project_dex_archive
│  │  │  │  │  ├─ debug
│  │  │  │  │  │  └─ dexBuilderDebug
│  │  │  │  │  │     └─ out
│  │  │  │  │  └─ release
│  │  │  │  │     └─ dexBuilderRelease
│  │  │  │  │        └─ out
│  │  │  │  ├─ symbol_list_with_package_name
│  │  │  │  │  ├─ debug
│  │  │  │  │  │  └─ processDebugResources
│  │  │  │  │  │     └─ package-aware-r.txt
│  │  │  │  │  └─ release
│  │  │  │  │     └─ processReleaseResources
│  │  │  │  │        └─ package-aware-r.txt
│  │  │  │  ├─ validate_signing_config
│  │  │  │  │  ├─ debug
│  │  │  │  │  │  └─ validateSigningDebug
│  │  │  │  │  └─ release
│  │  │  │  │     └─ validateSigningRelease
│  │  │  │  └─ version_control_info_file
│  │  │  │     └─ release
│  │  │  │        └─ extractReleaseVersionControlInfo
│  │  │  │           └─ version-control-info.textproto
│  │  │  ├─ kotlinToolingMetadata
│  │  │  │  └─ kotlin-tooling-metadata.json
│  │  │  ├─ outputs
│  │  │  │  ├─ apk
│  │  │  │  │  ├─ debug
│  │  │  │  │  │  ├─ app-debug.apk
│  │  │  │  │  │  └─ output-metadata.json
│  │  │  │  │  └─ release
│  │  │  │  │     ├─ OPTN-release-patch1.apk
│  │  │  │  │     ├─ app-release.apk
│  │  │  │  │     ├─ baselineProfiles
│  │  │  │  │     │  ├─ 0
│  │  │  │  │     │  │  └─ app-release.dm
│  │  │  │  │     │  └─ 1
│  │  │  │  │     │     └─ app-release.dm
│  │  │  │  │     └─ output-metadata.json
│  │  │  │  ├─ bundle
│  │  │  │  │  └─ release
│  │  │  │  │     ├─ app-release-signed.aab
│  │  │  │  │     └─ app-release.aab
│  │  │  │  └─ sdk-dependencies
│  │  │  │     └─ release
│  │  │  │        └─ sdkDependencies.txt
│  │  │  └─ tmp
│  │  │     ├─ compileDebugJavaWithJavac
│  │  │     │  ├─ compileTransaction
│  │  │     │  │  ├─ backup-dir
│  │  │     │  │  └─ stash-dir
│  │  │     │  │     └─ MainActivity.class.uniqueId0
│  │  │     │  └─ previous-compilation-data.bin
│  │  │     └─ compileReleaseJavaWithJavac
│  │  │        ├─ compileTransaction
│  │  │        │  ├─ backup-dir
│  │  │        │  └─ stash-dir
│  │  │        └─ previous-compilation-data.bin
│  │  ├─ build.gradle
│  │  ├─ capacitor.build.gradle
│  │  ├─ optn-key.keystore
│  │  ├─ optn-wallet-release.keystore
│  │  ├─ proguard-rules.pro
│  │  └─ src
│  │     ├─ androidTest
│  │     │  └─ java
│  │     │     └─ com
│  │     │        └─ getcapacitor
│  │     │           └─ myapp
│  │     │              └─ ExampleInstrumentedTest.java
│  │     ├─ main
│  │     │  ├─ AndroidManifest.xml
│  │     │  ├─ assets
│  │     │  │  ├─ capacitor.config.json
│  │     │  │  ├─ capacitor.plugins.json
│  │     │  │  └─ public
│  │     │  │     ├─ assets
│  │     │  │     │  ├─ bch-C7lBzaT0.png
│  │     │  │     │  ├─ ic_launcher-66abd8b866bfb
│  │     │  │     │  │  ├─ android
│  │     │  │     │  │  │  ├─ ic_launcher-web.png
│  │     │  │     │  │  │  ├─ mipmap-anydpi-v26
│  │     │  │     │  │  │  │  ├─ ic_launcher.xml
│  │     │  │     │  │  │  │  └─ ic_launcher_round.xml
│  │     │  │     │  │  │  ├─ mipmap-hdpi
│  │     │  │     │  │  │  │  ├─ ic_launcher.png
│  │     │  │     │  │  │  │  ├─ ic_launcher_foreground.png
│  │     │  │     │  │  │  │  └─ ic_launcher_round.png
│  │     │  │     │  │  │  ├─ mipmap-ldpi
│  │     │  │     │  │  │  │  └─ ic_launcher.png
│  │     │  │     │  │  │  ├─ mipmap-mdpi
│  │     │  │     │  │  │  │  ├─ ic_launcher.png
│  │     │  │     │  │  │  │  ├─ ic_launcher_foreground.png
│  │     │  │     │  │  │  │  └─ ic_launcher_round.png
│  │     │  │     │  │  │  ├─ mipmap-xhdpi
│  │     │  │     │  │  │  │  ├─ ic_launcher.png
│  │     │  │     │  │  │  │  ├─ ic_launcher_foreground.png
│  │     │  │     │  │  │  │  └─ ic_launcher_round.png
│  │     │  │     │  │  │  ├─ mipmap-xxhdpi
│  │     │  │     │  │  │  │  ├─ ic_launcher.png
│  │     │  │     │  │  │  │  ├─ ic_launcher_foreground.png
│  │     │  │     │  │  │  │  └─ ic_launcher_round.png
│  │     │  │     │  │  │  ├─ mipmap-xxxhdpi
│  │     │  │     │  │  │  │  ├─ ic_launcher.png
│  │     │  │     │  │  │  │  ├─ ic_launcher_foreground.png
│  │     │  │     │  │  │  │  └─ ic_launcher_round.png
│  │     │  │     │  │  │  ├─ playstore-icon.png
│  │     │  │     │  │  │  └─ values
│  │     │  │     │  │  │     └─ ic_launcher_background.xml
│  │     │  │     │  │  └─ ios
│  │     │  │     │  │     ├─ AppIcon.appiconset
│  │     │  │     │  │     │  ├─ Contents.json
│  │     │  │     │  │     │  ├─ Icon-App-20x20@1x.png
│  │     │  │     │  │     │  ├─ Icon-App-20x20@2x.png
│  │     │  │     │  │     │  ├─ Icon-App-20x20@3x.png
│  │     │  │     │  │     │  ├─ Icon-App-29x29@1x.png
│  │     │  │     │  │     │  ├─ Icon-App-29x29@2x.png
│  │     │  │     │  │     │  ├─ Icon-App-29x29@3x.png
│  │     │  │     │  │     │  ├─ Icon-App-40x40@1x.png
│  │     │  │     │  │     │  ├─ Icon-App-40x40@2x.png
│  │     │  │     │  │     │  ├─ Icon-App-40x40@3x.png
│  │     │  │     │  │     │  ├─ Icon-App-60x60@2x.png
│  │     │  │     │  │     │  ├─ Icon-App-60x60@3x.png
│  │     │  │     │  │     │  ├─ Icon-App-76x76@1x.png
│  │     │  │     │  │     │  ├─ Icon-App-76x76@2x.png
│  │     │  │     │  │     │  ├─ Icon-App-83.5x83.5@2x.png
│  │     │  │     │  │     │  └─ ItunesArtwork@2x.png
│  │     │  │     │  │     ├─ iTunesArtwork@1x.png
│  │     │  │     │  │     ├─ iTunesArtwork@2x.png
│  │     │  │     │  │     └─ iTunesArtwork@3x.png
│  │     │  │     │  ├─ images
│  │     │  │     │  │  ├─ EnterIcon1.png
│  │     │  │     │  │  ├─ EnterIcon2.png
│  │     │  │     │  │  ├─ Faucet.png
│  │     │  │     │  │  ├─ OPTNUIkeyline.png
│  │     │  │     │  │  ├─ OPTNUIkeyline2.png
│  │     │  │     │  │  ├─ OPTNWelcome1.png
│  │     │  │     │  │  ├─ OPTNWelcome2.png
│  │     │  │     │  │  ├─ OPTNWelcome3.png
│  │     │  │     │  │  └─ fundme.png
│  │     │  │     │  ├─ index-CREajJkM.js
│  │     │  │     │  ├─ index-CREajJkM.js.map
│  │     │  │     │  ├─ index-catUKt9N.css
│  │     │  │     │  ├─ index-wTwDO9zr.js
│  │     │  │     │  ├─ index-wTwDO9zr.js.map
│  │     │  │     │  ├─ revicons-BNIKeAUC.eot
│  │     │  │     │  ├─ revicons-CBqxZnew.ttf
│  │     │  │     │  ├─ revicons-DbTteTvA.woff
│  │     │  │     │  ├─ secp256k1-DAIEGPPj.js
│  │     │  │     │  ├─ secp256k1-DAIEGPPj.js.map
│  │     │  │     │  ├─ sql-wasm-hQY6UH0C.js
│  │     │  │     │  ├─ sql-wasm-hQY6UH0C.js.map
│  │     │  │     │  ├─ web-8-uMadbu.js
│  │     │  │     │  ├─ web-8-uMadbu.js.map
│  │     │  │     │  ├─ web-B6XdMQxJ.js
│  │     │  │     │  ├─ web-B6XdMQxJ.js.map
│  │     │  │     │  ├─ web-Cxoq0Gsc.js
│  │     │  │     │  ├─ web-Cxoq0Gsc.js.map
│  │     │  │     │  ├─ web-gbyWvC71.js
│  │     │  │     │  └─ web-gbyWvC71.js.map
│  │     │  │     ├─ cordova.js
│  │     │  │     ├─ cordova_plugins.js
│  │     │  │     ├─ index.html
│  │     │  │     └─ sql-wasm.wasm
│  │     │  ├─ java
│  │     │  │  └─ optn
│  │     │  │     └─ wallet
│  │     │  │        └─ app
│  │     │  │           └─ MainActivity.java
│  │     │  └─ res
│  │     │     ├─ drawable
│  │     │     │  ├─ ic_launcher_background.xml
│  │     │     │  └─ splash.png
│  │     │     ├─ drawable-land-hdpi
│  │     │     │  └─ splash.png
│  │     │     ├─ drawable-land-ldpi
│  │     │     │  └─ splash.png
│  │     │     ├─ drawable-land-mdpi
│  │     │     │  └─ splash.png
│  │     │     ├─ drawable-land-xhdpi
│  │     │     │  └─ splash.png
│  │     │     ├─ drawable-land-xxhdpi
│  │     │     │  └─ splash.png
│  │     │     ├─ drawable-land-xxxhdpi
│  │     │     │  └─ splash.png
│  │     │     ├─ drawable-port-hdpi
│  │     │     │  └─ splash.png
│  │     │     ├─ drawable-port-ldpi
│  │     │     │  └─ splash.png
│  │     │     ├─ drawable-port-mdpi
│  │     │     │  └─ splash.png
│  │     │     ├─ drawable-port-xhdpi
│  │     │     │  └─ splash.png
│  │     │     ├─ drawable-port-xxhdpi
│  │     │     │  └─ splash.png
│  │     │     ├─ drawable-port-xxxhdpi
│  │     │     │  └─ splash.png
│  │     │     ├─ drawable-v24
│  │     │     │  └─ ic_launcher_foreground.xml
│  │     │     ├─ layout
│  │     │     │  └─ activity_main.xml
│  │     │     ├─ mipmap-anydpi-v26
│  │     │     │  ├─ ic_launcher.xml
│  │     │     │  └─ ic_launcher_round.xml
│  │     │     ├─ mipmap-hdpi
│  │     │     │  ├─ ic_launcher.png
│  │     │     │  ├─ ic_launcher_foreground.png
│  │     │     │  └─ ic_launcher_round.png
│  │     │     ├─ mipmap-ldpi
│  │     │     │  └─ ic_launcher.png
│  │     │     ├─ mipmap-mdpi
│  │     │     │  ├─ ic_launcher.png
│  │     │     │  ├─ ic_launcher_foreground.png
│  │     │     │  └─ ic_launcher_round.png
│  │     │     ├─ mipmap-xhdpi
│  │     │     │  ├─ ic_launcher.png
│  │     │     │  ├─ ic_launcher_foreground.png
│  │     │     │  └─ ic_launcher_round.png
│  │     │     ├─ mipmap-xxhdpi
│  │     │     │  ├─ ic_launcher.png
│  │     │     │  ├─ ic_launcher_foreground.png
│  │     │     │  └─ ic_launcher_round.png
│  │     │     ├─ mipmap-xxxhdpi
│  │     │     │  ├─ ic_launcher.png
│  │     │     │  ├─ ic_launcher_foreground.png
│  │     │     │  └─ ic_launcher_round.png
│  │     │     ├─ values
│  │     │     │  ├─ ic_launcher_background.xml
│  │     │     │  ├─ strings.xml
│  │     │     │  └─ styles.xml
│  │     │     └─ xml
│  │     │        ├─ config.xml
│  │     │        └─ file_paths.xml
│  │     └─ test
│  │        └─ java
│  │           └─ com
│  │              └─ getcapacitor
│  │                 └─ myapp
│  │                    └─ ExampleUnitTest.java
│  ├─ build
│  │  ├─ kotlin
│  │  │  └─ sessions
│  │  └─ reports
│  │     └─ problems
│  │        └─ problems-report.html
│  ├─ build.gradle
│  ├─ capacitor-cordova-android-plugins
│  │  ├─ build
│  │  │  ├─ .transforms
│  │  │  │  ├─ 1c85e3c870b6be8af4fba65223c29069
│  │  │  │  │  ├─ results.bin
│  │  │  │  │  └─ transformed
│  │  │  │  │     └─ classes
│  │  │  │  │        ├─ classes_dex
│  │  │  │  │        └─ classes_global-synthetics
│  │  │  │  └─ 3ba715b67793fee3ceea210c72bde2f7
│  │  │  │     ├─ results.bin
│  │  │  │     └─ transformed
│  │  │  │        └─ bundleLibRuntimeToDirDebug
│  │  │  │           ├─ bundleLibRuntimeToDirDebug_dex
│  │  │  │           ├─ bundleLibRuntimeToDirDebug_global-synthetics
│  │  │  │           └─ desugar_graph.bin
│  │  │  ├─ generated
│  │  │  │  └─ res
│  │  │  │     ├─ pngs
│  │  │  │     │  └─ debug
│  │  │  │     └─ resValues
│  │  │  │        └─ debug
│  │  │  ├─ intermediates
│  │  │  │  ├─ aapt_friendly_merged_manifests
│  │  │  │  │  └─ debug
│  │  │  │  │     └─ processDebugManifest
│  │  │  │  │        └─ aapt
│  │  │  │  │           ├─ AndroidManifest.xml
│  │  │  │  │           └─ output-metadata.json
│  │  │  │  ├─ aar_libs_directory
│  │  │  │  │  └─ debug
│  │  │  │  │     └─ syncDebugLibJars
│  │  │  │  │        └─ libs
│  │  │  │  ├─ aar_main_jar
│  │  │  │  │  └─ debug
│  │  │  │  │     └─ syncDebugLibJars
│  │  │  │  │        └─ classes.jar
│  │  │  │  ├─ aar_metadata
│  │  │  │  │  └─ debug
│  │  │  │  │     └─ writeDebugAarMetadata
│  │  │  │  │        └─ aar-metadata.properties
│  │  │  │  ├─ annotation_processor_list
│  │  │  │  │  └─ debug
│  │  │  │  │     └─ javaPreCompileDebug
│  │  │  │  │        └─ annotationProcessors.json
│  │  │  │  ├─ annotations_typedef_file
│  │  │  │  │  └─ debug
│  │  │  │  │     └─ extractDebugAnnotations
│  │  │  │  │        └─ typedefs.txt
│  │  │  │  ├─ annotations_zip
│  │  │  │  │  └─ debug
│  │  │  │  │     └─ extractDebugAnnotations
│  │  │  │  ├─ compile_library_classes_jar
│  │  │  │  │  └─ debug
│  │  │  │  │     └─ bundleLibCompileToJarDebug
│  │  │  │  │        └─ classes.jar
│  │  │  │  ├─ compile_r_class_jar
│  │  │  │  │  └─ debug
│  │  │  │  │     └─ generateDebugRFile
│  │  │  │  │        └─ R.jar
│  │  │  │  ├─ compile_symbol_list
│  │  │  │  │  └─ debug
│  │  │  │  │     └─ generateDebugRFile
│  │  │  │  │        └─ R.txt
│  │  │  │  ├─ compiled_local_resources
│  │  │  │  │  └─ debug
│  │  │  │  │     └─ compileDebugLibraryResources
│  │  │  │  │        └─ out
│  │  │  │  ├─ data_binding_layout_info_type_package
│  │  │  │  │  └─ debug
│  │  │  │  │     └─ packageDebugResources
│  │  │  │  │        └─ out
│  │  │  │  ├─ incremental
│  │  │  │  │  ├─ debug
│  │  │  │  │  │  └─ packageDebugResources
│  │  │  │  │  │     ├─ compile-file-map.properties
│  │  │  │  │  │     ├─ merged.dir
│  │  │  │  │  │     ├─ merger.xml
│  │  │  │  │  │     └─ stripped.dir
│  │  │  │  │  ├─ debug-mergeJavaRes
│  │  │  │  │  │  ├─ merge-state
│  │  │  │  │  │  └─ zip-cache
│  │  │  │  │  ├─ mergeDebugJniLibFolders
│  │  │  │  │  │  └─ merger.xml
│  │  │  │  │  ├─ mergeDebugShaders
│  │  │  │  │  │  └─ merger.xml
│  │  │  │  │  └─ packageDebugAssets
│  │  │  │  │     └─ merger.xml
│  │  │  │  ├─ library_and_local_jars_jni
│  │  │  │  │  └─ debug
│  │  │  │  │     └─ copyDebugJniLibsProjectAndLocalJars
│  │  │  │  │        └─ jni
│  │  │  │  ├─ library_assets
│  │  │  │  │  └─ debug
│  │  │  │  │     └─ packageDebugAssets
│  │  │  │  │        └─ out
│  │  │  │  ├─ library_jni
│  │  │  │  │  └─ debug
│  │  │  │  │     └─ copyDebugJniLibsProjectOnly
│  │  │  │  │        └─ jni
│  │  │  │  ├─ local_only_symbol_list
│  │  │  │  │  └─ debug
│  │  │  │  │     └─ parseDebugLocalResources
│  │  │  │  │        └─ R-def.txt
│  │  │  │  ├─ manifest_merge_blame_file
│  │  │  │  │  └─ debug
│  │  │  │  │     └─ processDebugManifest
│  │  │  │  │        └─ manifest-merger-blame-debug-report.txt
│  │  │  │  ├─ merged_java_res
│  │  │  │  │  └─ debug
│  │  │  │  │     └─ mergeDebugJavaResource
│  │  │  │  │        └─ feature-capacitor-cordova-android-plugins.jar
│  │  │  │  ├─ merged_jni_libs
│  │  │  │  │  └─ debug
│  │  │  │  │     └─ mergeDebugJniLibFolders
│  │  │  │  │        └─ out
│  │  │  │  ├─ merged_manifest
│  │  │  │  │  └─ debug
│  │  │  │  │     └─ processDebugManifest
│  │  │  │  │        └─ AndroidManifest.xml
│  │  │  │  ├─ merged_shaders
│  │  │  │  │  └─ debug
│  │  │  │  │     └─ mergeDebugShaders
│  │  │  │  │        └─ out
│  │  │  │  ├─ navigation_json
│  │  │  │  │  └─ debug
│  │  │  │  │     └─ extractDeepLinksDebug
│  │  │  │  │        └─ navigation.json
│  │  │  │  ├─ nested_resources_validation_report
│  │  │  │  │  └─ debug
│  │  │  │  │     └─ generateDebugResources
│  │  │  │  │        └─ nestedResourcesValidationReport.txt
│  │  │  │  ├─ packaged_res
│  │  │  │  │  └─ debug
│  │  │  │  │     └─ packageDebugResources
│  │  │  │  ├─ public_res
│  │  │  │  │  └─ debug
│  │  │  │  │     └─ packageDebugResources
│  │  │  │  ├─ runtime_library_classes_dir
│  │  │  │  │  └─ debug
│  │  │  │  │     └─ bundleLibRuntimeToDirDebug
│  │  │  │  ├─ runtime_library_classes_jar
│  │  │  │  │  └─ debug
│  │  │  │  │     └─ bundleLibRuntimeToJarDebug
│  │  │  │  │        └─ classes.jar
│  │  │  │  └─ symbol_list_with_package_name
│  │  │  │     └─ debug
│  │  │  │        └─ generateDebugRFile
│  │  │  │           └─ package-aware-r.txt
│  │  │  └─ outputs
│  │  │     └─ aar
│  │  │        └─ capacitor-cordova-android-plugins-debug.aar
│  │  ├─ build.gradle
│  │  ├─ cordova.variables.gradle
│  │  └─ src
│  │     └─ main
│  │        ├─ AndroidManifest.xml
│  │        ├─ java
│  │        └─ res
│  ├─ capacitor.settings.gradle
│  ├─ gradle
│  │  └─ wrapper
│  │     ├─ gradle-wrapper.jar
│  │     └─ gradle-wrapper.properties
│  ├─ gradle.properties
│  ├─ gradlew
│  ├─ gradlew.bat
│  ├─ local.properties
│  ├─ settings.gradle
│  └─ variables.gradle
├─ build.sh
├─ capacitor.config.ts
├─ index.html
├─ ios
│  ├─ App
│  │  ├─ App
│  │  │  ├─ AppDelegate.swift
│  │  │  ├─ Assets.xcassets
│  │  │  │  ├─ AppIcon.appiconset
│  │  │  │  │  ├─ AppIcon-512@2x.png
│  │  │  │  │  └─ Contents.json
│  │  │  │  ├─ Contents.json
│  │  │  │  └─ Splash.imageset
│  │  │  │     ├─ Contents.json
│  │  │  │     ├─ Default@1x~universal~anyany.png
│  │  │  │     ├─ Default@2x~universal~anyany.png
│  │  │  │     ├─ Default@3x~universal~anyany.png
│  │  │  │     ├─ splash-2732x2732-1.png
│  │  │  │     ├─ splash-2732x2732-2.png
│  │  │  │     └─ splash-2732x2732.png
│  │  │  ├─ Base.lproj
│  │  │  │  ├─ LaunchScreen.storyboard
│  │  │  │  └─ Main.storyboard
│  │  │  ├─ Info.plist
│  │  │  ├─ capacitor.config.json
│  │  │  ├─ config.xml
│  │  │  └─ public
│  │  │     ├─ assets
│  │  │     │  ├─ bch-C7lBzaT0.png
│  │  │     │  ├─ ic_launcher-66abd8b866bfb
│  │  │     │  │  ├─ android
│  │  │     │  │  │  ├─ ic_launcher-web.png
│  │  │     │  │  │  ├─ mipmap-anydpi-v26
│  │  │     │  │  │  │  ├─ ic_launcher.xml
│  │  │     │  │  │  │  └─ ic_launcher_round.xml
│  │  │     │  │  │  ├─ mipmap-hdpi
│  │  │     │  │  │  │  ├─ ic_launcher.png
│  │  │     │  │  │  │  ├─ ic_launcher_foreground.png
│  │  │     │  │  │  │  └─ ic_launcher_round.png
│  │  │     │  │  │  ├─ mipmap-ldpi
│  │  │     │  │  │  │  └─ ic_launcher.png
│  │  │     │  │  │  ├─ mipmap-mdpi
│  │  │     │  │  │  │  ├─ ic_launcher.png
│  │  │     │  │  │  │  ├─ ic_launcher_foreground.png
│  │  │     │  │  │  │  └─ ic_launcher_round.png
│  │  │     │  │  │  ├─ mipmap-xhdpi
│  │  │     │  │  │  │  ├─ ic_launcher.png
│  │  │     │  │  │  │  ├─ ic_launcher_foreground.png
│  │  │     │  │  │  │  └─ ic_launcher_round.png
│  │  │     │  │  │  ├─ mipmap-xxhdpi
│  │  │     │  │  │  │  ├─ ic_launcher.png
│  │  │     │  │  │  │  ├─ ic_launcher_foreground.png
│  │  │     │  │  │  │  └─ ic_launcher_round.png
│  │  │     │  │  │  ├─ mipmap-xxxhdpi
│  │  │     │  │  │  │  ├─ ic_launcher.png
│  │  │     │  │  │  │  ├─ ic_launcher_foreground.png
│  │  │     │  │  │  │  └─ ic_launcher_round.png
│  │  │     │  │  │  ├─ playstore-icon.png
│  │  │     │  │  │  └─ values
│  │  │     │  │  │     └─ ic_launcher_background.xml
│  │  │     │  │  └─ ios
│  │  │     │  │     ├─ AppIcon.appiconset
│  │  │     │  │     │  ├─ Contents.json
│  │  │     │  │     │  ├─ Icon-App-20x20@1x.png
│  │  │     │  │     │  ├─ Icon-App-20x20@2x.png
│  │  │     │  │     │  ├─ Icon-App-20x20@3x.png
│  │  │     │  │     │  ├─ Icon-App-29x29@1x.png
│  │  │     │  │     │  ├─ Icon-App-29x29@2x.png
│  │  │     │  │     │  ├─ Icon-App-29x29@3x.png
│  │  │     │  │     │  ├─ Icon-App-40x40@1x.png
│  │  │     │  │     │  ├─ Icon-App-40x40@2x.png
│  │  │     │  │     │  ├─ Icon-App-40x40@3x.png
│  │  │     │  │     │  ├─ Icon-App-60x60@2x.png
│  │  │     │  │     │  ├─ Icon-App-60x60@3x.png
│  │  │     │  │     │  ├─ Icon-App-76x76@1x.png
│  │  │     │  │     │  ├─ Icon-App-76x76@2x.png
│  │  │     │  │     │  ├─ Icon-App-83.5x83.5@2x.png
│  │  │     │  │     │  └─ ItunesArtwork@2x.png
│  │  │     │  │     ├─ iTunesArtwork@1x.png
│  │  │     │  │     ├─ iTunesArtwork@2x.png
│  │  │     │  │     └─ iTunesArtwork@3x.png
│  │  │     │  ├─ images
│  │  │     │  │  ├─ EnterIcon1.png
│  │  │     │  │  ├─ EnterIcon2.png
│  │  │     │  │  ├─ Faucet.png
│  │  │     │  │  ├─ OPTNUIkeyline.png
│  │  │     │  │  ├─ OPTNUIkeyline2.png
│  │  │     │  │  ├─ OPTNWelcome1.png
│  │  │     │  │  ├─ OPTNWelcome2.png
│  │  │     │  │  ├─ OPTNWelcome3.png
│  │  │     │  │  └─ fundme.png
│  │  │     │  ├─ index-CREajJkM.js
│  │  │     │  ├─ index-CREajJkM.js.map
│  │  │     │  ├─ index-catUKt9N.css
│  │  │     │  ├─ index-wTwDO9zr.js
│  │  │     │  ├─ index-wTwDO9zr.js.map
│  │  │     │  ├─ revicons-BNIKeAUC.eot
│  │  │     │  ├─ revicons-CBqxZnew.ttf
│  │  │     │  ├─ revicons-DbTteTvA.woff
│  │  │     │  ├─ secp256k1-DAIEGPPj.js
│  │  │     │  ├─ secp256k1-DAIEGPPj.js.map
│  │  │     │  ├─ sql-wasm-hQY6UH0C.js
│  │  │     │  ├─ sql-wasm-hQY6UH0C.js.map
│  │  │     │  ├─ web-8-uMadbu.js
│  │  │     │  ├─ web-8-uMadbu.js.map
│  │  │     │  ├─ web-B6XdMQxJ.js
│  │  │     │  ├─ web-B6XdMQxJ.js.map
│  │  │     │  ├─ web-Cxoq0Gsc.js
│  │  │     │  ├─ web-Cxoq0Gsc.js.map
│  │  │     │  ├─ web-gbyWvC71.js
│  │  │     │  └─ web-gbyWvC71.js.map
│  │  │     ├─ cordova.js
│  │  │     ├─ cordova_plugins.js
│  │  │     ├─ index.html
│  │  │     └─ sql-wasm.wasm
│  │  ├─ App.xcodeproj
│  │  │  └─ project.pbxproj
│  │  ├─ App.xcworkspace
│  │  │  └─ xcshareddata
│  │  │     └─ IDEWorkspaceChecks.plist
│  │  └─ Podfile
│  └─ capacitor-cordova-ios-plugins
│     ├─ CordovaPlugins.podspec
│     ├─ CordovaPluginsResources.podspec
│     ├─ CordovaPluginsStatic.podspec
│     ├─ resources
│     └─ sources
├─ module.d.ts
├─ package-lock.json
├─ package.json
├─ postcss.config.js
├─ public
│  ├─ assets
│  │  ├─ ic_launcher-66abd8b866bfb
│  │  │  ├─ android
│  │  │  │  ├─ ic_launcher-web.png
│  │  │  │  ├─ mipmap-anydpi-v26
│  │  │  │  │  ├─ ic_launcher.xml
│  │  │  │  │  └─ ic_launcher_round.xml
│  │  │  │  ├─ mipmap-hdpi
│  │  │  │  │  ├─ ic_launcher.png
│  │  │  │  │  ├─ ic_launcher_foreground.png
│  │  │  │  │  └─ ic_launcher_round.png
│  │  │  │  ├─ mipmap-ldpi
│  │  │  │  │  └─ ic_launcher.png
│  │  │  │  ├─ mipmap-mdpi
│  │  │  │  │  ├─ ic_launcher.png
│  │  │  │  │  ├─ ic_launcher_foreground.png
│  │  │  │  │  └─ ic_launcher_round.png
│  │  │  │  ├─ mipmap-xhdpi
│  │  │  │  │  ├─ ic_launcher.png
│  │  │  │  │  ├─ ic_launcher_foreground.png
│  │  │  │  │  └─ ic_launcher_round.png
│  │  │  │  ├─ mipmap-xxhdpi
│  │  │  │  │  ├─ ic_launcher.png
│  │  │  │  │  ├─ ic_launcher_foreground.png
│  │  │  │  │  └─ ic_launcher_round.png
│  │  │  │  ├─ mipmap-xxxhdpi
│  │  │  │  │  ├─ ic_launcher.png
│  │  │  │  │  ├─ ic_launcher_foreground.png
│  │  │  │  │  └─ ic_launcher_round.png
│  │  │  │  ├─ playstore-icon.png
│  │  │  │  └─ values
│  │  │  │     └─ ic_launcher_background.xml
│  │  │  └─ ios
│  │  │     ├─ AppIcon.appiconset
│  │  │     │  ├─ Contents.json
│  │  │     │  ├─ Icon-App-20x20@1x.png
│  │  │     │  ├─ Icon-App-20x20@2x.png
│  │  │     │  ├─ Icon-App-20x20@3x.png
│  │  │     │  ├─ Icon-App-29x29@1x.png
│  │  │     │  ├─ Icon-App-29x29@2x.png
│  │  │     │  ├─ Icon-App-29x29@3x.png
│  │  │     │  ├─ Icon-App-40x40@1x.png
│  │  │     │  ├─ Icon-App-40x40@2x.png
│  │  │     │  ├─ Icon-App-40x40@3x.png
│  │  │     │  ├─ Icon-App-60x60@2x.png
│  │  │     │  ├─ Icon-App-60x60@3x.png
│  │  │     │  ├─ Icon-App-76x76@1x.png
│  │  │     │  ├─ Icon-App-76x76@2x.png
│  │  │     │  ├─ Icon-App-83.5x83.5@2x.png
│  │  │     │  └─ ItunesArtwork@2x.png
│  │  │     ├─ iTunesArtwork@1x.png
│  │  │     ├─ iTunesArtwork@2x.png
│  │  │     └─ iTunesArtwork@3x.png
│  │  └─ images
│  │     ├─ EnterIcon1.png
│  │     ├─ EnterIcon2.png
│  │     ├─ Faucet.png
│  │     ├─ OPTNUIkeyline.png
│  │     ├─ OPTNUIkeyline2.png
│  │     ├─ OPTNWelcome1.png
│  │     ├─ OPTNWelcome2.png
│  │     ├─ OPTNWelcome3.png
│  │     └─ fundme.png
│  └─ sql-wasm.wasm
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
│  │  ├─ priceFeedSlice copy.ts
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
│  │  ├─ BcmrSnapshotStorage.ts
│  │  ├─ ElectrumService.ts
│  │  ├─ ElectrumServiceTemp.ts
│  │  ├─ ElectrumSubscriptionManager.ts
│  │  ├─ KeyService copy.ts
│  │  ├─ KeyService.ts
│  │  ├─ Notify.ts
│  │  ├─ TransactionService.ts
│  │  ├─ UTXOService.ts
│  │  ├─ priceService copy.ts
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