// src/pages/apps/MarketplaceAppHost.tsx

// @ts-nocheck WIP app surface; see docs/wip-typecheck-exclusions.md

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { useSelector } from 'react-redux';

import { RootState } from '../../state/store';
import AddonsRegistry from '../../services/AddonsRegistry';
import { getAddonGrantedCapabilities } from '../../services/AddonsAllowlist';
import { resolveParyonWorkspaceSnapshot } from '../../services/paryon/ParyonService';
import KeyService from '../../services/KeyService';
import TransactionService from '../../services/TransactionService';
import UTXOService from '../../services/UTXOService';
import ElectrumService from '../../services/ElectrumService';
import {
  ElectrumNetworkProvider,
  HashType,
  SignatureTemplate,
  TransactionBuilder,
} from 'cashscript';

import type {
  AddonManifest,
  AddonAppDefinition,
  AddonCapability,
} from '../../types/addons';
import {
  createAddonSDK,
  createPublicAddonSDK,
  type AddonSDK,
  type AddonTransactionProposal,
} from '../../services/AddonsSDK';
import type { UTXO } from '../../types/types';
import { renderDeclarativeScreen } from './marketplaceScreenResolver';
import AddonIframeHost from './AddonIframeHost';
import {
  createP2pkhExecutionAuthority,
  isP2pkhCashAddress,
} from '../../services/addons/P2pkhExecutionAdapter';
import { createCashTokenExecutionAuthority } from '../../services/addons/CashTokenExecutionAuthority';
import {
  createAddonExecutionRouter,
  hasCashTokenProposalState,
  hasContractProposalState,
} from '../../services/addons/AddonExecutionRouter';
import { createContractExecutionAuthority } from '../../services/addons/ContractExecutionAuthority';
import { createWalletCashScriptContract } from '../../services/addons/CashScriptCompatibility';
import { assertAddonWalletInputState } from '../../services/addons/AddonInputStateVerifier';
import { createAddonDurableStores } from '../../services/addons/AddonDurableStorage';
import { recoverPersistedAddonOperations } from '../../services/addons/AddonOperationRecoveryCoordinator';
import { createAddonTransactionVisibilityRecoveryResolver } from '../../services/addons/AddonTransactionVisibilityRecovery';
import { getReturnPath } from '../../utils/navigation';
import {
  isComingSoonApp,
  shouldHideApp,
} from '../../features/apps/appsViewHelpers';
import { Capacitor } from '@capacitor/core';
import { useI18n } from '../../i18n/useI18n';
import { AddonI18nProvider } from '../../i18n/AddonI18nProvider';
import { getLocalizedAddonAppName } from '../../services/addons/AddonLocale';
import type { AddonModuleId } from '../../i18n/addonModuleCatalog';
import type { TranslationKey } from '../../i18n/resources';

type ResolvedApp = {
  manifest: AddonManifest;
  app: AddonAppDefinition;
};

type AddonAppConfig = {
  screen?: string;
};

type AddonAppWithConfig = AddonAppDefinition & {
  config?: AddonAppConfig | null;
};

type PromptDecision = 'allow-once' | 'allow-always' | 'deny';
type ConsentPrompt = {
  mode: 'launch' | 'runtime';
  title: string;
  message: string;
  appKey: string;
  capability?: AddonCapability;
  capabilities?: AddonCapability[];
};
type PersistedConsent = Record<string, Record<string, true>>;

const CONSENT_STORAGE_KEY = 'optn.addon.consent.v1';
const SENSITIVE_RUNTIME_CAPABILITIES = new Set<AddonCapability>([
  'tx:broadcast',
  'signing:message_sign',
  'signing:signature_template',
]);

function isTrustedAddon(manifest: AddonManifest): boolean {
  return manifest.trustTier === 'internal';
}

function readPersistedConsent(): PersistedConsent {
  try {
    const raw = localStorage.getItem(CONSENT_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed as PersistedConsent;
  } catch {
    return {};
  }
}

function writePersistedConsent(next: PersistedConsent): void {
  try {
    localStorage.setItem(CONSENT_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // best-effort persistence
  }
}

function capabilityTranslationKey(capability: AddonCapability): TranslationKey {
  switch (capability) {
    case 'wallet:context:read':
      return 'apps.capability.walletContextRead';
    case 'wallet:addresses:read':
      return 'apps.capability.walletAddressesRead';
    case 'utxo:wallet:read':
      return 'apps.capability.walletUtxosRead';
    case 'utxo:address:read':
      return 'apps.capability.addressUtxosRead';
    case 'utxo:address:refresh':
      return 'apps.capability.addressUtxosRefresh';
    case 'bcmr:token:read':
      return 'apps.capability.tokenMetadataRead';
    case 'tokenindex:holders:read':
      return 'apps.capability.tokenHoldersRead';
    case 'tx:build':
      return 'apps.capability.buildTransactions';
    case 'tx:add_output':
      return 'apps.capability.addOutputs';
    case 'tx:broadcast':
      return 'apps.capability.broadcastTransactions';
    case 'signing:message_sign':
      return 'apps.capability.signMessages';
    case 'signing:signature_template':
      return 'apps.capability.signatureTemplates';
    case 'http:fetch_json':
      return 'apps.capability.fetchJson';
    default:
      return 'apps.capability';
  }
}

function parseAppKey(appIdParam: string | undefined): {
  addonId?: string;
  appId?: string;
} {
  const raw = (appIdParam ?? '').trim();
  if (!raw) return {};
  // supported:
  // - "authguard" (global search)
  // - "<addonId>:<appId>" (preferred)
  if (raw.includes(':')) {
    const [addonId, ...rest] = raw.split(':').filter(Boolean);
    const appId = rest.join(':');
    return { addonId, appId };
  }
  return { appId: raw };
}

function normalizeAppIdAlias(appId: string): string {
  const normalized = appId.trim();
  if (!normalized) return normalized;
  switch (normalized.toLowerCase()) {
    case 'airdropsapp':
    case 'eventrewardsapp':
      return 'airdropsApp';
    default:
      return normalized;
  }
}

function getDeclarativeScreenId(app: AddonAppDefinition): string {
  // v1: map declarative apps by config.screen (preferred), else fall back to app.id
  const cfg = (app as AddonAppWithConfig).config ?? null;
  const screen = typeof cfg?.screen === 'string' ? cfg.screen.trim() : '';
  return screen || app.id;
}

function getAddonModuleId(screenId: string): AddonModuleId | undefined {
  switch (screenId) {
    case 'AuthGuard':
    case 'AuthGuardApp':
    case 'authguard':
      return 'authguard';
    case 'AirdropsApp':
    case 'EventRewardsApp':
    case 'eventRewardsApp':
    case 'airdropsApp':
      return 'airdrops';
    case 'FundMeAddonApp':
    case 'fundmeApp':
      return 'fundme';
    case 'MemoCashReaderApp':
    case 'memoCashReaderApp':
      return 'memo-cash-reader';
    case 'MintCashTokensPoCApp':
    case 'mintCashTokensPoCApp':
    case 'mint-cashtokens-poc':
      return 'mint-cashtokens';
    case 'CauldronSwapApp':
    case 'cauldronSwapApp':
      return 'cauldron';
    case 'ParyonWorkspaceApp':
    case 'paryonWorkspaceApp':
      return 'paryon';
    case 'MerchantPayApp':
    case 'merchantPayApp':
      return 'merchant-pay';
    default:
      return undefined;
  }
}

function isDisabledApp(app: AddonAppDefinition): boolean {
  const isNativeRuntime = Capacitor.isNativePlatform();
  const comingSoon = isComingSoonApp(app.id, app.name);

  return shouldHideApp(app.id, app.name) || (comingSoon && isNativeRuntime);
}

export default function MarketplaceAppHost() {
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const location = useLocation();
  const backTarget = getReturnPath(location, '/apps');
  const { appId: appIdParam } = useParams();

  const walletId = useSelector(
    (state: RootState) => state.wallet_id.currentWalletId
  );
  const network = useSelector(
    (state: RootState) => state.network.currentNetwork
  );

  const [loading, setLoading] = useState(true);
  const [resolved, setResolved] = useState<ResolvedApp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [launchApproved, setLaunchApproved] = useState(false);

  // optional hardening: preload addresses once per wallet
  const [walletAddresses, setWalletAddresses] = useState<Set<string> | null>(
    null
  );
  const [persistedConsent, setPersistedConsent] = useState<PersistedConsent>(
    () => readPersistedConsent()
  );
  const [consentPrompt, setConsentPrompt] = useState<ConsentPrompt | null>(
    null
  );
  const formatCapability = useCallback(
    (capability: AddonCapability): string =>
      t(capabilityTranslationKey(capability)),
    [t]
  );
  const promptOpenRef = useRef(false);
  const promptQueueRef = useRef<
    Array<{
      prompt: ConsentPrompt;
      resolve: (decision: PromptDecision) => void;
    }>
  >([]);
  const activeResolverRef = useRef<((decision: PromptDecision) => void) | null>(
    null
  );
  const sdkSessionId = useMemo(() => {
    const randomId =
      typeof globalThis.crypto?.randomUUID === 'function'
        ? globalThis.crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return `addon-session-v1:${randomId}`;
  }, [walletId, resolved?.manifest.id, resolved?.app.id]);
  const sdkSessionExpiresAt = useMemo(
    () => new Date(Date.now() + 30 * 60_000).toISOString(),
    [sdkSessionId]
  );

  const parsed = useMemo(() => {
    const key = parseAppKey(appIdParam);
    return {
      addonId: key.addonId,
      appId: key.appId ? normalizeAppIdAlias(key.appId) : key.appId,
    };
  }, [appIdParam]);
  const trustedAddon = useMemo(
    () => (resolved ? isTrustedAddon(resolved.manifest) : false),
    [resolved]
  );
  const localizedAppName = useMemo(
    () =>
      resolved
        ? getLocalizedAddonAppName(resolved.manifest, resolved.app, locale)
        : '',
    [locale, resolved]
  );
  const paryonContractAddresses = useMemo(() => {
    if (!resolved) return new Set<string>();
    if (!resolved.app.id.toLowerCase().includes('paryonworkspaceapp')) {
      return new Set<string>();
    }

    try {
      const paryonSnapshot = resolveParyonWorkspaceSnapshot(network);
      return new Set(
        paryonSnapshot.contracts
          .map((contract) => contract.address)
          .filter((address) => !!address && address !== '(unresolved)')
      );
    } catch {
      return new Set<string>();
    }
  }, [network, resolved]);
  const allowedWalletAddresses = useMemo(() => {
    if (!walletAddresses && paryonContractAddresses.size === 0) return null;

    const next = new Set<string>(walletAddresses ?? []);
    for (const address of paryonContractAddresses) {
      next.add(address);
    }
    return next;
  }, [paryonContractAddresses, walletAddresses]);
  const appConsentKey = useMemo(() => {
    if (!resolved || !walletId) return '';
    return `${walletId}:${resolved.manifest.id}:${resolved.app.id}`;
  }, [resolved, walletId]);
  const grantRevision = useMemo(
    () => Object.keys(persistedConsent[appConsentKey] ?? {}).length,
    [appConsentKey, persistedConsent]
  );

  const hasPersistedCapabilityGrant = useCallback(
    (appKey: string, capability: AddonCapability) =>
      Boolean(persistedConsent[appKey]?.[capability]),
    [persistedConsent]
  );

  const persistCapabilityGrant = useCallback(
    (appKey: string, capability: AddonCapability) => {
      setPersistedConsent((prev) => {
        const existing = prev[appKey] ?? {};
        if (existing[capability]) return prev;
        const next: PersistedConsent = {
          ...prev,
          [appKey]: {
            ...existing,
            [capability]: true,
          },
        };
        writePersistedConsent(next);
        return next;
      });
    },
    []
  );

  const showPrompt = useCallback(
    (entry: {
      prompt: ConsentPrompt;
      resolve: (decision: PromptDecision) => void;
    }) => {
      promptOpenRef.current = true;
      setConsentPrompt(entry.prompt);

      activeResolverRef.current = (decision: PromptDecision) => {
        entry.resolve(decision);
        setConsentPrompt(null);

        const next = promptQueueRef.current.shift();
        if (next) {
          showPrompt(next);
          return;
        }

        promptOpenRef.current = false;
        activeResolverRef.current = null;
      };
    },
    []
  );

  const requestPrompt = useCallback(
    (prompt: ConsentPrompt): Promise<PromptDecision> =>
      new Promise((resolve) => {
        const entry = { prompt, resolve };
        if (!promptOpenRef.current) {
          showPrompt(entry);
          return;
        }
        promptQueueRef.current.push(entry);
      }),
    [showPrompt]
  );

  const resolvePrompt = useCallback((decision: PromptDecision) => {
    activeResolverRef.current?.(decision);
  }, []);

  useEffect(() => {
    let mounted = true;

    (async () => {
      try {
        setLoading(true);
        setError(null);

        const addons = AddonsRegistry();
        await addons.init();

        const manifests = addons.getAddons();
        let found: ResolvedApp | null = null;

        if (parsed.addonId && parsed.appId) {
          const m = manifests.find((x) => x.id === parsed.addonId);
          const app = m?.apps?.find((a) => a.id === parsed.appId);
          if (m && app) found = { manifest: m, app };
        } else if (parsed.appId) {
          for (const m of manifests) {
            const app = m.apps?.find((a) => a.id === parsed.appId);
            if (app) {
              found = { manifest: m, app };
              break;
            }
          }
        }

        if (!found) {
          throw new Error(`App not found: ${appIdParam ?? ''}`);
        }

        if (mounted) setResolved(found);
      } catch (e: unknown) {
        if (mounted) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (mounted) setLoading(false);
      }
    })();

    return () => {
      mounted = false;
    };
  }, [appIdParam, parsed.addonId, parsed.appId]);

  useEffect(() => {
    setLaunchApproved(false);
  }, [appConsentKey]);

  // preload wallet addresses for SDK hardening (best-effort)
  useEffect(() => {
    let mounted = true;

    (async () => {
      try {
        if (!walletId) {
          if (mounted) setWalletAddresses(null);
          return;
        }
        const keys = await KeyService.retrieveKeys(walletId);
        const set = new Set<string>();
        for (const key of keys as Array<{
          address?: string | null;
          tokenAddress?: string | null;
        }>) {
          if (key.address) set.add(key.address);
          if (key.tokenAddress) set.add(key.tokenAddress);
        }
        if (mounted) setWalletAddresses(set);
      } catch {
        // best-effort; address-scoped SDK methods will fail closed if allowlist is unavailable
        if (mounted) setWalletAddresses(null);
      }
    })();

    return () => {
      mounted = false;
    };
  }, [walletId]);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        if (!resolved || !walletId) {
          if (!cancelled) setLaunchApproved(false);
          return;
        }

        if (isDisabledApp(resolved.app)) {
          if (!cancelled) setLaunchApproved(false);
          return;
        }

        if (isTrustedAddon(resolved.manifest)) {
          if (!cancelled) setLaunchApproved(true);
          return;
        }

        const appKey = `${walletId}:${resolved.manifest.id}:${resolved.app.id}`;
        const requestedCaps = (
          resolved.app.requiredCapabilities?.length
            ? resolved.app.requiredCapabilities
            : Array.from(getAddonGrantedCapabilities(resolved.manifest))
        ).filter(Boolean);

        if (requestedCaps.length === 0) {
          if (!cancelled) setLaunchApproved(true);
          return;
        }

        const ungranted = requestedCaps.filter(
          (cap) => !hasPersistedCapabilityGrant(appKey, cap)
        );

        if (ungranted.length === 0) {
          if (!cancelled) setLaunchApproved(true);
          return;
        }

        const decision = await requestPrompt({
          mode: 'launch',
          appKey,
          capabilities: ungranted,
          title: t('apps.allowCapabilities', { name: localizedAppName }),
          message: t('apps.capabilitiesMessage'),
        });

        if (cancelled) return;

        if (decision === 'deny') {
          setError(t('apps.permissionDenied'));
          setLaunchApproved(false);
          return;
        }

        if (decision === 'allow-always') {
          for (const cap of ungranted) {
            persistCapabilityGrant(appKey, cap);
          }
        }

        setLaunchApproved(true);
      } catch (e: unknown) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setLaunchApproved(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    hasPersistedCapabilityGrant,
    persistCapabilityGrant,
    requestPrompt,
    resolved,
    localizedAppName,
    t,
    walletId,
  ]);

  const authorizeCapability = useCallback(
    async ({
      capability,
      addonId,
    }: {
      capability: AddonCapability;
      addonId: string;
    }) => {
      if (!resolved || !walletId) {
        throw new Error('Missing addon runtime context');
      }

      if (addonId !== resolved.manifest.id) {
        throw new Error('Addon context mismatch while authorizing capability');
      }

      if (isTrustedAddon(resolved.manifest)) return;
      if (!SENSITIVE_RUNTIME_CAPABILITIES.has(capability)) return;

      const appKey = `${walletId}:${resolved.manifest.id}:${resolved.app.id}`;
      if (hasPersistedCapabilityGrant(appKey, capability)) return;

      const decision = await requestPrompt({
        mode: 'runtime',
        appKey,
        capability,
        title: t('apps.allowSensitiveAction'),
        message: t('apps.capabilityRequested', {
          name: localizedAppName,
          capability: formatCapability(capability),
        }),
      });

      if (decision === 'deny') {
        throw new Error(`User denied addon permission: ${capability}`);
      }

      if (decision === 'allow-always') {
        persistCapabilityGrant(appKey, capability);
      }
    },
    [
      hasPersistedCapabilityGrant,
      persistCapabilityGrant,
      requestPrompt,
      resolved,
      localizedAppName,
      formatCapability,
      t,
      walletId,
    ]
  );

  const sdk: AddonSDK | null = useMemo(() => {
    if (!resolved || !walletId) return null;
    if (!trustedAddon && !launchApproved) return null;

    const createSdk = trustedAddon ? createAddonSDK : createPublicAddonSDK;
    const transactionService = TransactionService;
    const durableStores = createAddonDurableStores({
      walletId,
      addonId: resolved.manifest.id,
      network,
    });
    const isOwnedP2pkhAddress = (address: string) =>
      isP2pkhCashAddress(address) &&
      Boolean(allowedWalletAddresses?.has(address));
    const verifyInputs = async ({
      proposal,
      inputs,
    }: {
      proposal: AddonTransactionProposal;
      inputs: UTXO[];
    }) => {
      if (!allowedWalletAddresses || allowedWalletAddresses.size === 0) {
        throw new Error('Wallet input allowlist is unavailable');
      }
      const addresses = Array.from(new Set(proposal.inputs.map((input) => input.address)));
      const contractIndexes = new Set(proposal.contract?.contractInputIndexes ?? []);
      if (proposal.contract?.contractAddress) {
        for (const index of contractIndexes) {
          const input = proposal.inputs[index];
          if (input && input.address !== proposal.contract.contractAddress && input.tokenAddress !== proposal.contract.contractAddress) {
            throw new Error('Contract input does not match the declared contract address');
          }
        }
      }
      const nonContractAddresses = proposal.inputs
        .filter((_, index) => !contractIndexes.has(index))
        .map((input) => input.address);
      if (nonContractAddresses.some((address) => !allowedWalletAddresses.has(address))) {
        throw new Error('Addon proposal input is outside the wallet allowlist');
      }
      const byAddress = await UTXOService.fetchAndStoreUTXOsMany(
        walletId,
        addresses,
        { discover: false, chainAuthoritative: true }
      );
      assertAddonWalletInputState({
        proposal,
        actualInputs: addresses.flatMap((address) => byAddress[address] ?? []),
      });
    };
    const p2pkhAuthority = createP2pkhExecutionAuthority({
      isP2pkhAddress: isOwnedP2pkhAddress,
      verifyInputs,
      resolveChangeAddress: async () => {
        const changeAddress = Array.from(allowedWalletAddresses ?? []).find(
          isP2pkhCashAddress
        );
        if (!changeAddress) {
          throw new Error('No P2PKH wallet change address is available');
        }
        return changeAddress;
      },
      buildTransaction: async ({ inputs, outputs, changeAddress }) => {
        const built = await transactionService.buildTransaction(
          outputs,
          null,
          changeAddress,
          inputs
        );
        return {
          finalTransaction: built.finalTransaction,
          errorMsg: built.errorMsg,
        };
      },
      sendTransaction: async (rawTransaction, inputs) =>
        await transactionService.sendTransaction(rawTransaction, inputs, {
          walletId,
        }),
    });
    const cashTokenAuthority = createCashTokenExecutionAuthority({
      isSupportedAddress: isOwnedP2pkhAddress,
      verifyInputs,
      resolveChangeAddress: async () => {
        const changeAddress = Array.from(allowedWalletAddresses ?? []).find(
          isP2pkhCashAddress
        );
        if (!changeAddress) {
          throw new Error('No P2PKH wallet change address is available');
        }
        return changeAddress;
      },
      buildTransaction: async ({
        inputs,
        outputs,
        changeAddress,
        allowImplicitFungibleTokenBurn,
      }) => {
        const built = await transactionService.buildTransaction(
          outputs,
          null,
          changeAddress,
          inputs,
          allowImplicitFungibleTokenBurn
        );
        return {
          finalTransaction: built.finalTransaction,
          errorMsg: built.errorMsg,
        };
      },
      sendTransaction: async (rawTransaction, inputs) =>
        await transactionService.sendTransaction(rawTransaction, inputs, {
          walletId,
        }),
    });
    const contractAuthority = createContractExecutionAuthority({
      verifyInputs,
      buildAndSend: async ({ proposal }) => {
        const metadata = proposal.contract;
        if (!metadata) throw new Error('Contract metadata is required');
        const indexes = metadata.contractInputIndexes;
        if (!Array.isArray(indexes) || indexes.length === 0) {
          throw new Error('Contract input indexes are required');
        }
        const contract = createWalletCashScriptContract({
          artifact: metadata.artifact,
          constructorArgs: (metadata.constructorArgs ?? []).map((arg: any) => arg?.value ?? arg),
          provider: new ElectrumNetworkProvider(network),
          contractType: metadata.contractType ?? 'p2sh32',
        });
        const derivedLockingBytecode = typeof contract.lockingBytecode === 'string'
          ? contract.lockingBytecode
          : Array.from(contract.lockingBytecode as Uint8Array, (byte: number) => byte.toString(16).padStart(2, '0')).join('');
        if (metadata.contractLockingBytecode && derivedLockingBytecode !== metadata.contractLockingBytecode) {
          throw new Error('Contract constructor arguments or type do not match the declared locking bytecode');
        }
        if (metadata.contractAddress && metadata.contractType !== 'p2s') {
          const derivedAddress = metadata.contractType === 'p2sh20' ? contract.address : contract.tokenAddress ?? contract.address;
          if (derivedAddress !== metadata.contractAddress) throw new Error('Contract identity does not match the declared address');
        }
        const signerTemplates = new Map<string, any>();
        for (const binding of metadata.signerBindings ?? []) {
          const key = await KeyService.fetchAddressPrivateKey(binding.address, 'spend');
          if (!key) throw new Error(`Wallet signing key unavailable for ${binding.address}`);
          signerTemplates.set(
            `${binding.purpose}:${binding.address}`,
            new SignatureTemplate(key, HashType.SIGHASH_ALL)
          );
        }
        const functionArgs = (metadata.functionArgs ?? []).map((arg: any) => {
          if (arg?.type === 'sig' && arg.signer) {
            const template = signerTemplates.get(`${arg.signer.purpose}:${arg.signer.address}`);
            if (!template) throw new Error('Contract signer binding was not resolved by the wallet');
            return template;
          }
          return arg?.value ?? arg;
        });
        const builder = new TransactionBuilder({
          provider: new ElectrumNetworkProvider(network),
        });
        const contractIndexSet = new Set(indexes);
        for (let index = 0; index < proposal.inputs.length; index += 1) {
          const input = proposal.inputs[index];
          const utxo: any = {
            txid: input.txid,
            vout: input.vout,
            satoshis: BigInt(input.valueSats),
            ...(input.tokenCategory
              ? { token: { category: input.tokenCategory, amount: BigInt(input.tokenAmount ?? '0'), ...(input.tokenNft ? { nft: input.tokenNft } : {}) } }
              : {}),
          };
          const unlocker = contractIndexSet.has(index)
            ? contract.unlock[metadata.functionName](...functionArgs)
            : (() => {
                if (!input.address) throw new Error('Wallet input address is required');
                return KeyService.fetchAddressPrivateKey(input.address, 'spend');
              })();
          if (unlocker instanceof Promise) {
            const key = await unlocker;
            if (!key) throw new Error(`Wallet signing key unavailable for ${input.address}`);
            builder.addInput(utxo, new SignatureTemplate(key, HashType.SIGHASH_ALL).unlockP2PKH());
            continue;
          }
          builder.addInput(utxo, unlocker);
        }
        for (const output of proposal.outputs) {
          if ('opReturn' in output && output.opReturn) {
            builder.addOpReturnOutput(output.opReturn);
          } else {
            builder.addOutput({
              to: output.recipientAddress,
              amount: BigInt(output.amount),
              ...(output.token
                ? { token: { category: output.token.category, amount: BigInt(output.token.amount), ...(output.token.nft ? { nft: output.token.nft } : {}) } }
                : {}),
            });
          }
        }
        const changeAddress = Array.from(allowedWalletAddresses ?? []).find(isP2pkhCashAddress);
        if (!changeAddress) throw new Error('No P2PKH wallet change address is available');
        const categories = new Set(
          proposal.inputs.map((input) => input.tokenCategory).filter(Boolean)
        );
        for (const category of categories) {
          const inputAmount = proposal.inputs
            .filter((input) => input.tokenCategory === category)
            .reduce((total, input) => total + BigInt(input.tokenAmount ?? '0'), 0n);
          const outputAmount = proposal.outputs
            .filter((output) => !('opReturn' in output) && output.token?.category === category)
            .reduce((total, output) => total + BigInt(output.token?.amount ?? 0), 0n);
          if (inputAmount > outputAmount) {
            const nftInput = proposal.inputs.find(
              (input) => input.tokenCategory === category && input.tokenNft
            );
            const nftOutput = proposal.outputs.some(
              (output) => !('opReturn' in output) && output.token?.category === category && output.token?.nft
            );
            builder.addOutput({
              to: changeAddress,
              amount: 546n,
              token: {
                category,
                amount: inputAmount - outputAmount,
                ...(nftInput?.tokenNft && !nftOutput ? { nft: nftInput.tokenNft } : {}),
              },
            });
          }
        }
        // Include a tentative BCH output when estimating size, then replace it
        // with the exact fee-aware amount. CashScript 0.13 exposes the builder
        // output list but not the 0.14 change helpers.
        builder.addOutput({ to: changeAddress, amount: 546n });
        const preliminaryHex = builder.build();
        builder.outputs.pop();
        const inputSats = proposal.inputs.reduce((total, input) => total + BigInt(input.valueSats), 0n);
        const outputSats = proposal.outputs.reduce(
          (total, output) => total + ('opReturn' in output ? 0n : BigInt(output.amount)),
          0n
        ) + BigInt([...categories].reduce((count, category) => {
          const inputAmount = proposal.inputs.filter((input) => input.tokenCategory === category).reduce((total, input) => total + BigInt(input.tokenAmount ?? '0'), 0n);
          const outputAmount = proposal.outputs.filter((output) => !('opReturn' in output) && output.token?.category === category).reduce((total, output) => total + BigInt(output.token?.amount ?? 0), 0n);
          return count + (inputAmount > outputAmount ? 546 : 0);
        }, 0));
        const fee = BigInt(Math.ceil((preliminaryHex.length / 2) * 1));
        const bchChange = inputSats - outputSats - fee;
        if (bchChange < 0n) {
          throw new Error('Contract transaction does not have enough BCH for outputs and fees');
        }
        if (bchChange >= 546n) {
          builder.addOutput({ to: changeAddress, amount: bchChange });
        }
        const rawTransaction = await builder.build();
        const spentInputs = proposal.inputs.map((input: any) => ({
          ...input,
          tx_hash: input.txid,
          tx_pos: input.vout,
          value: Number(input.valueSats),
        }));
        const sent = await transactionService.sendTransaction(rawTransaction, spentInputs, { walletId });
        return {
          txid: sent.txid ?? null,
          errorMessage: sent.errorMessage ?? null,
          broadcastState: sent.txid ? 'broadcasted' : 'submitted',
        };
      },
    });
    const executionAuthority = createAddonExecutionRouter([
      {
        name: 'cashscript-contract',
        matches: hasContractProposalState,
        authority: contractAuthority,
      },
      {
        name: 'cashtoken',
        matches: hasCashTokenProposalState,
        authority: cashTokenAuthority,
      },
      {
        name: 'p2pkh-bch',
        matches: (proposal) => !hasCashTokenProposalState(proposal),
        authority: p2pkhAuthority,
      },
    ]);
    return createSdk(resolved.manifest, {
      walletId,
      network,
      sessionId: sdkSessionId,
      sessionExpiresAt: sdkSessionExpiresAt,
      grantRevision,
      requireAddressAllowlist: true,
      walletAddresses: allowedWalletAddresses ?? undefined,
      allowedCapabilities: resolved.app.requiredCapabilities
        ? new Set(resolved.app.requiredCapabilities)
        : undefined,
      authorizeCapability: trustedAddon ? undefined : authorizeCapability,
      // The SDK receives only the signed response. KeyService and its private
      // key handling remain inside the wallet host process.
      signMessage: async ({ address, message }) =>
        await KeyService.signMessageForAddress(address, message),
      approveMessageSigning: async ({ address, message }) => {
        if (trustedAddon) return true;
        const decision = await requestPrompt({
          mode: 'runtime',
          appKey: appConsentKey,
          title: t('apps.allowSensitiveAction'),
          message: `${t('apps.capabilityRequested', {
            name: localizedAppName,
            capability: 'message signing',
          })} ${address}\n\nMessage:\n${message.slice(0, 2048)}${message.length > 2048 ? '…' : ''}`,
        });
        return decision !== 'deny';
      },
      approveExecution: async ({ proposal, mode }) => {
        if (trustedAddon) return true;
        const contractReview = proposal.contract
          ? `\n\nContract: ${proposal.contract.contractAddress ?? proposal.contract.contractId}\nFunction: ${proposal.contract.functionName}\nContract inputs: ${(proposal.contract.contractInputIndexes ?? []).join(', ')}`
          : '';
        const tokenReview = proposal.tokenIntent
          ? `\nToken intent: ${proposal.tokenIntent.kind}`
          : '';
        const decision = await requestPrompt({
          mode: 'runtime',
          appKey: appConsentKey,
          title: t('apps.allowSensitiveAction'),
          message: `${t('apps.capabilityRequested', {
            name: localizedAppName,
            capability: `transaction execution (${mode})`,
          })} ${proposal.proposalId}${contractReview}${tokenReview}`,
        });
        return decision !== 'deny';
      },
      validateProposalAuthority: (proposal) =>
        proposal.sessionId === sdkSessionId &&
        proposal.grantRevision === grantRevision,
      executionAuthority,
      proposalStore: durableStores.proposalStore,
      operationStore: durableStores.operationStore,
      allowLegacyKeyBearingSigning:
        trustedAddon && resolved.app.kind === 'declarative',
      allowLegacyTransactionExecution:
        trustedAddon && resolved.app.kind === 'declarative',
    });
  }, [
    authorizeCapability,
    launchApproved,
    resolved,
    trustedAddon,
    allowedWalletAddresses,
    walletId,
    network,
    sdkSessionId,
    sdkSessionExpiresAt,
    grantRevision,
    appConsentKey,
    requestPrompt,
    t,
    localizedAppName,
  ]);

  // Reconcile ambiguous submissions before exposing the durable SDK session.
  // The resolver stays host-owned and returns only a bounded lifecycle state.
  useEffect(() => {
    if (!resolved || !walletId) return;
    let cancelled = false;
    const stores = createAddonDurableStores({
      walletId,
      addonId: resolved.manifest.id,
      network,
    });
    void recoverPersistedAddonOperations(
      stores.operationStore,
      createAddonTransactionVisibilityRecoveryResolver((txid) =>
        cancelled
          ? Promise.resolve({ seen: false, confirmed: false })
          : ElectrumService.getTransactionVisibility(txid)
      )
    ).catch(() => {
      // Recovery is best effort; the persisted unknown state remains visible
      // until a later wallet-owned reconciliation succeeds.
    });
    return () => {
      cancelled = true;
    };
  }, [network, resolved, walletId]);

  const onAddonConnectRequest = useCallback(
    async ({
      addonId,
      requestedCapabilities,
    }: {
      addonId: string;
      requestedCapabilities: string[];
    }) => {
      if (!resolved || addonId !== resolved.manifest.id) return null;
      const declared = new Set(resolved.app.requiredCapabilities ?? []);
      if (requestedCapabilities.some((capability) => !declared.has(capability)))
        return null;
      for (const capability of requestedCapabilities) {
        await authorizeCapability({
          addonId,
          capability: capability as AddonCapability,
        });
      }
      return {
        sessionId: sdkSessionId,
        expiresAt: sdkSessionExpiresAt,
        capabilities: requestedCapabilities.slice(),
      };
    },
    [authorizeCapability, resolved, sdkSessionExpiresAt, sdkSessionId]
  );

  const loadWalletAddresses = async () => {
    if (!walletId) return new Set<string>();
    // if already loaded, reuse
    if (walletAddresses) return walletAddresses;

    const keys = await KeyService.retrieveKeys(walletId);
    const addresses = new Set<string>();
    for (const key of keys as Array<{
      address?: string | null;
      tokenAddress?: string | null;
    }>) {
      if (key.address) addresses.add(key.address);
      if (key.tokenAddress) addresses.add(key.tokenAddress);
    }
    return addresses;
  };

  // Patient-0: map declarative app => local component
  const renderApp = () => {
    if (!resolved || !sdk) return null;

    if (resolved.app.kind === 'iframe-bundle') {
      // The only place third-party (non-built-in) addon code executes — see
      // AddonIframeHost.tsx for the sandboxed-iframe isolation model. `sdk`
      // here is the SAME capability-gated object declarative apps use; this
      // component never gives the addon anything beyond that.
      return (
        <AddonIframeHost
          manifest={resolved.manifest}
          app={resolved.app}
          sdk={sdk}
          sessionId={sdkSessionId}
          onConnectRequest={onAddonConnectRequest}
        />
      );
    }

    if (resolved.app.kind !== 'declarative') {
      return (
        <div className="p-4">
          <div className="font-bold">{t('apps.unsupportedAppKind')}</div>
          <pre className="text-sm">{String(resolved.app.kind)}</pre>
        </div>
      );
    }

    const screenId = getDeclarativeScreenId(resolved.app);
    const moduleId = getAddonModuleId(screenId);

    const rendered = renderDeclarativeScreen({
      screenId,
      resolved,
      sdk,
      loadWalletAddresses,
    });
    if (rendered) {
      return (
        <AddonI18nProvider manifest={resolved.manifest} moduleId={moduleId}>
          {rendered}
        </AddonI18nProvider>
      );
    }

    return (
      <div className="p-4">
        <div className="font-bold">{t('apps.unsupportedDeclarativeApp')}</div>
        <div className="text-sm text-gray-700 mt-1">
          {t('apps.expectedScreen')}
        </div>
        <div className="mt-3 text-sm">
          <div className="font-semibold">{t('apps.resolvedScreenId')}</div>
          <pre className="text-xs bg-gray-100 p-2 rounded">
            {String(screenId)}
          </pre>

          <div className="font-semibold mt-3">{t('apps.appDefinition')}</div>
          <pre className="text-xs bg-gray-100 p-2 rounded overflow-x-auto">
            {JSON.stringify(resolved.app, null, 2)}
          </pre>
        </div>
      </div>
    );
  };

  if (loading) {
    return (
      <div className="container mx-auto p-4">
        <div className="text-lg font-semibold">{t('apps.loadingApp')}</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="container mx-auto p-4">
        <div className="text-lg font-semibold text-red-600">
          {t('apps.failedToLoad')}
        </div>
        <div className="mt-2 text-sm text-gray-700">{error}</div>

        <button
          onClick={() => navigate(backTarget)}
          className="mt-4 bg-blue-500 hover:bg-blue-600 text-white py-2 px-4 rounded"
        >
          {t('apps.back')}
        </button>
      </div>
    );
  }

  if (!walletId) {
    return (
      <div className="container mx-auto p-4">
        <div className="text-lg font-semibold">{t('apps.noWallet')}</div>
        <button
          onClick={() => navigate('/landing')}
          className="mt-4 bg-blue-500 hover:bg-blue-600 text-white py-2 px-4 rounded"
        >
          {t('apps.goToLanding')}
        </button>
      </div>
    );
  }

  if (resolved && isDisabledApp(resolved.app)) {
    return (
      <div className="container mx-auto p-4">
        <div className="text-lg font-semibold">{localizedAppName}</div>
        <div className="mt-2 wallet-muted">{t('apps.comingSoon')}.</div>
        <button
          onClick={() => navigate(backTarget)}
          className="wallet-btn-secondary mt-4"
        >
          {t('apps.back')}
        </button>
      </div>
    );
  }

  if (!trustedAddon && !launchApproved) {
    return (
      <div className="container mx-auto p-4">
        <div className="text-lg font-semibold">
          {t('apps.waitingPermission')}
        </div>
        <div className="mt-2 text-sm wallet-muted">
          {t('apps.approveCapabilities')}
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="mx-auto flex h-full min-h-0 w-full max-w-md flex-col px-4">
        <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain touch-pan-y pr-1">
          {renderApp()}
        </div>
      </div>
      {consentPrompt && (
        <div className="wallet-popup-backdrop">
          <div className="wallet-popup-panel max-w-lg">
            <div className="text-lg font-semibold">{consentPrompt.title}</div>
            <div className="mt-2 text-sm wallet-muted">
              {consentPrompt.message}
            </div>

            {consentPrompt.mode === 'launch' &&
              Array.isArray(consentPrompt.capabilities) &&
              consentPrompt.capabilities.length > 0 && (
                <ul className="mt-3 space-y-1 text-sm">
                  {consentPrompt.capabilities.map((cap) => (
                    <li key={cap}>• {formatCapability(cap)}</li>
                  ))}
                </ul>
              )}

            {consentPrompt.mode === 'runtime' && consentPrompt.capability && (
              <div className="mt-3 text-sm">
                {t('apps.capability')}{' '}
                {formatCapability(consentPrompt.capability)}
              </div>
            )}

            <div className="mt-5 flex flex-wrap gap-2">
              <button
                type="button"
                className="wallet-btn-danger"
                onClick={() => resolvePrompt('deny')}
              >
                {t('apps.deny')}
              </button>
              <button
                type="button"
                className="wallet-btn-secondary"
                onClick={() => resolvePrompt('allow-once')}
              >
                {t('apps.allowOnce')}
              </button>
              <button
                type="button"
                className="wallet-btn-primary"
                onClick={() => resolvePrompt('allow-always')}
              >
                {t('apps.alwaysAllow')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
