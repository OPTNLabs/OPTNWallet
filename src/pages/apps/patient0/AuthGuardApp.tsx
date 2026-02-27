// src/pages/apps/patient0/AuthGuardApp.tsx

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AddonManifest, AddonAppDefinition } from '../../../types/addons';
import type { AddonSDK } from '../../../services/AddonsSDK';
import type { UTXO, TransactionOutput, Token } from '../../../types/types';

import AddressManager from '../../../apis/AddressManager/AddressManager';
import AUTHGUARD_ARTIFACT from '../../../apis/ContractManager/artifacts/AuthGuard.json';
import { DUST, TOKEN_OUTPUT_SATS } from '../../../utils/constants';

import { Contract, ElectrumNetworkProvider } from 'cashscript';
import { store } from '../../../redux/store';
import { Network } from '../../../redux/networkSlice';
import parseInputValue from '../../../utils/parseInputValue';
import TransactionBuilderHelper from '../../../apis/TransactionManager/TransactionBuilderHelper';

import {
  queryUnspentOutputsByLockingBytecode,
  stripChaingraphHexBytes,
} from '../../../apis/ChaingraphManager/ChaingraphManager';

type Props = {
  manifest: AddonManifest;
  app: AddonAppDefinition;
  sdk: AddonSDK;

  /**
   * Optional hardening hook – used to build a wallet address allowlist
   * for “send-to-self” testing without exposing arbitrary address access.
   */
  loadWalletAddresses: () => Promise<Set<string>>;
};

function toBigIntSafe(v: unknown): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return 0n;
    return BigInt(Math.trunc(v));
  }
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return 0n;
    try {
      return BigInt(s);
    } catch {
      return 0n;
    }
  }
  return 0n;
}

function normalizeCategory(x: unknown): string {
  if (typeof x !== 'string') return '';
  return x.trim().toLowerCase().replace(/^0x/i, '');
}

function normalizeTokenIdTxid(tokenId: string): string {
  const hex = normalizeCategory(tokenId);
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new Error(
      `Invalid tokenId/txid (expected 64 hex chars): ${String(tokenId)}`
    );
  }
  return hex;
}

function currentWalletId(): number {
  try {
    const id = Number(store.getState().wallet_id.currentWalletId ?? 0);
    return Number.isFinite(id) ? id : 0;
  } catch {
    return 0;
  }
}

async function toCashTokenAddressForWallet(
  walletId: number,
  address: string
): Promise<string> {
  const addr = String(address ?? '').trim();
  if (!addr) return '';
  if (!walletId) return addr;

  try {
    const manager = AddressManager();
    const mapped = await manager.fetchTokenAddress(walletId, addr);
    return mapped || addr;
  } catch {
    return addr;
  }
}

function toTokenCashaddrFallback(address: string): string {
  // Pragmatic fallback:
  // - q... -> z...
  // - p... -> y...
  const a = String(address ?? '').trim();
  if (!a) return '';

  const lower = a.toLowerCase();

  // Already token-aware
  if (lower.includes(':z') || lower.includes(':y')) return a;
  if (!lower.includes(':')) {
    const c0 = lower[0];
    if (c0 === 'q') return `z${a.slice(1)}`;
    if (c0 === 'p') return `y${a.slice(1)}`;
    return a;
  }

  const [prefix, payloadRaw] = a.split(':', 2);
  const payload = payloadRaw ?? '';
  if (!payload) return a;

  const c0 = payload[0]?.toLowerCase();
  if (c0 === 'q') return `${prefix}:z${payload.slice(1)}`;
  if (c0 === 'p') return `${prefix}:y${payload.slice(1)}`;
  return a;
}

async function toCashTokenAddressBestEffort(
  walletId: number,
  address: string
): Promise<string> {
  const addr = String(address ?? '').trim();
  if (!addr) return '';

  // Wallet mapping first (wallet-controlled addresses)
  const mapped = await toCashTokenAddressForWallet(walletId, addr);
  if (mapped && mapped !== addr) return mapped;

  // Fallback for contract/external addresses
  return toTokenCashaddrFallback(addr);
}

function tokenAmountIsZero(t: Token | null | undefined): boolean {
  if (!t) return false;
  return toBigIntSafe((t as any).amount ?? 0) === 0n;
}

function currentNetwork(): Network {
  try {
    return store.getState().network.currentNetwork;
  } catch {
    return Network.MAINNET;
  }
}

function uniqUtxos(list: UTXO[]): UTXO[] {
  const m = new Map<string, UTXO>();
  for (const u of list) {
    const k = `${u.tx_hash}:${u.tx_pos}`;
    if (!m.has(k)) m.set(k, u);
  }
  return [...m.values()];
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function mergeWalletUtxos(res: any): UTXO[] {
  const all: UTXO[] = Array.isArray(res?.allUtxos) ? res.allUtxos : [];
  const tok: UTXO[] = Array.isArray(res?.tokenUtxos) ? res.tokenUtxos : [];
  const tok2: UTXO[] = Array.isArray(res?.cashTokenUtxos)
    ? res.cashTokenUtxos
    : [];
  return uniqUtxos([...(all ?? []), ...(tok ?? []), ...(tok2 ?? [])]);
}

type MintType = 'ft' | 'nft';
type MintTarget = 'authguard' | 'custom';

export default function AuthGuardApp({
  manifest,
  sdk,
  loadWalletAddresses,
}: Props) {
  const [walletUtxos, setWalletUtxos] = useState<UTXO[]>([]);
  const [selected, setSelected] = useState<UTXO | null>(null);

  // AuthGuard v1 states
  const [genesisUtxo, setGenesisUtxo] = useState<UTXO | null>(null);
  const [authHeadUtxo, setAuthHeadUtxo] = useState<UTXO | null>(null);
  const [authKeyUtxo, setAuthKeyUtxo] = useState<UTXO | null>(null);

  const [recipient, setRecipient] = useState<string>('');
  const [ftAmount, setFtAmount] = useState<string>('1'); // bigint string
  const [keepGuarded, setKeepGuarded] = useState<boolean>(true);

  // Step 0A: Create AuthKey (independent)
  const [authKeyOwner, setAuthKeyOwner] = useState<string>('');
  const [step0AStatus, setStep0AStatus] = useState<string>('');

  // Step 0B: Mint token (independent)
  const [mintType, setMintType] = useState<MintType>('ft');
  const [mintTarget, setMintTarget] = useState<MintTarget>('authguard');
  const [mintTo, setMintTo] = useState<string>(''); // only used when mintTarget=custom
  const [mintFtAmount, setMintFtAmount] = useState<string>('1000000');
  const [mintNftCapability, setMintNftCapability] = useState<
    'none' | 'mutable' | 'minting'
  >('none');
  const [mintNftCommitment, setMintNftCommitment] = useState<string>(''); // hex
  const [mintAlsoAuthKey, setMintAlsoAuthKey] = useState<boolean>(false);
  const [step0BStatus, setStep0BStatus] = useState<string>('');

  const [feeUtxo, setFeeUtxo] = useState<UTXO | null>(null);

  const [buildHex, setBuildHex] = useState<string>('');
  const [buildBytes, setBuildBytes] = useState<number>(0);
  const [buildErr, setBuildErr] = useState<string>('');
  const [busy, setBusy] = useState(false);

  // Chaingraph authhead discovery
  const [authHeadCandidatesChain, setAuthHeadCandidatesChain] = useState<
    UTXO[]
  >([]);
  const [authHeadStatus, setAuthHeadStatus] = useState<string>('');
  const [authGuardCashAddress, setAuthGuardCashAddress] = useState<string>('');
  const [authGuardTokenAddress, setAuthGuardTokenAddress] =
    useState<string>('');

  // ---------------------------------------------------------------------------
  // Derived values
  // ---------------------------------------------------------------------------

  const tokenId: string | null = useMemo(() => {
    // Preferred: explicitly selected genesis UTXO (vout=0 non-token)
    if (genesisUtxo && genesisUtxo.tx_pos === 0 && !genesisUtxo.token) {
      return genesisUtxo.tx_hash;
    }

    // Convenience: if user selected an AuthKey NFT, use its category
    const cat = (authKeyUtxo as any)?.token?.category;
    if (typeof cat === 'string') {
      const hex = cat.trim().toLowerCase().replace(/^0x/i, '');
      if (/^[0-9a-f]{64}$/.test(hex)) return hex;
    }

    return null;
  }, [genesisUtxo, authKeyUtxo]);

  const MIN_GENESIS_SATS = useMemo(() => {
    const base = 2 * Number(TOKEN_OUTPUT_SATS);
    const margin = 2500;
    const min = base + margin;
    return Math.max(min, 12000);
  }, []);

  // ---------------------------------------------------------------------------
  // Wallet UTXO refresh
  // ---------------------------------------------------------------------------

  const refreshWalletUtxos = useCallback(async () => {
    setBusy(true);
    setBuildErr('');
    try {
      const res = await sdk.utxos.listForWallet();
      const merged = mergeWalletUtxos(res);
      setWalletUtxos(merged);

      const pickFee =
        merged.find(
          (u) => (u.value ?? 0) > 3000 && !u.token && !u.abi && !u.contractName
        ) ??
        merged.find((u) => (u.value ?? 0) > 3000 && !u.token) ??
        null;
      setFeeUtxo(pickFee);

      const pick =
        merged.find((u) => (u.value ?? 0) > 1200 && !u.token) ??
        merged[0] ??
        null;
      setSelected(pick ?? null);
    } catch (e: any) {
      setBuildErr(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }, [sdk]);

  // ---------------------------------------------------------------------------
  // tx helpers (build + broadcast inside wallet)
  // ---------------------------------------------------------------------------

  async function buildTx(
    inputs: UTXO[],
    outputs: TransactionOutput[],
    changeAddress: string
  ) {
    const res = await sdk.tx.build({ inputs, outputs, changeAddress });
    if (res.errorMsg) throw new Error(res.errorMsg);
    if (!res.hex) throw new Error('build returned no hex');
    return { hex: res.hex, bytes: res.bytes || 0 };
  }

  async function broadcastTx(hex: string) {
    const ok = window.confirm(
      'Broadcast this transaction?\n\nThis will spend UTXOs from your wallet and cannot be undone.'
    );
    if (!ok) throw new Error('Broadcast cancelled by user.');

    const tb = TransactionBuilderHelper();
    const txid = await tb.sendTransaction(hex);
    if (!txid || typeof txid !== 'string') {
      throw new Error(`Broadcast returned invalid txid: ${String(txid)}`);
    }
    return txid;
  }

  async function getPrimaryWalletAddress(): Promise<string> {
    const allow = await loadWalletAddresses();
    const addr = [...allow][0];
    if (!addr) throw new Error('No wallet addresses found.');
    return addr;
  }

  function findSuitableGenesisCandidate(
    all: UTXO[],
    addr: string
  ): UTXO | null {
    return (
      all.find(
        (u) =>
          u.address === addr &&
          !u.token &&
          u.tx_pos === 0 &&
          (u.value ?? 0) >= MIN_GENESIS_SATS
      ) ?? null
    );
  }

  function findAuthKeyForTokenId(
    all: UTXO[],
    tokenIdHex: string,
    addr: string
  ) {
    const t = normalizeCategory(tokenIdHex);
    return (
      all.find((u) => {
        if (u.address !== addr) return false;
        if (!u.token) return false;
        if (!tokenAmountIsZero(u.token)) return false; // NFT-only
        if (!u.token.nft) return false;
        if (u.token.nft.capability !== 'none') return false;
        return normalizeCategory(u.token.category) === t;
      }) ?? null
    );
  }

  function deriveAuthGuardAddress(tokenIdHex: string): string {
    const net = currentNetwork();
    const provider = new ElectrumNetworkProvider(net);

    const ctorInputs = (AUTHGUARD_ARTIFACT as any)?.constructorInputs ?? [];
    if (!Array.isArray(ctorInputs) || ctorInputs.length !== 1) {
      throw new Error('AuthGuard artifact constructorInputs unexpected shape.');
    }

    const parsedArg = parseInputValue(`0x${tokenIdHex}`, ctorInputs[0].type);

    const c = new Contract(AUTHGUARD_ARTIFACT as any, [parsedArg], {
      provider,
      addressType: 'p2sh32',
    });

    return c.address;
  }

  function deriveAuthGuardTokenAddress(tokenIdHex: string): string {
    const net = currentNetwork();
    const provider = new ElectrumNetworkProvider(net);

    const ctorInputs = (AUTHGUARD_ARTIFACT as any)?.constructorInputs ?? [];
    if (!Array.isArray(ctorInputs) || ctorInputs.length !== 1) {
      throw new Error('AuthGuard artifact constructorInputs unexpected shape.');
    }

    const parsedArg = parseInputValue(`0x${tokenIdHex}`, ctorInputs[0].type);

    const c: any = new Contract(AUTHGUARD_ARTIFACT as any, [parsedArg], {
      provider,
      addressType: 'p2sh32',
    });

    const tokenAddr = String(c?.tokenAddress ?? '').trim();
    return tokenAddr || c.address;
  }

  function deriveAuthGuardLockingBytecodeHex(tokenIdHex: string): string {
    const net = currentNetwork();
    const provider = new ElectrumNetworkProvider(net);

    const ctorInputs = (AUTHGUARD_ARTIFACT as any)?.constructorInputs ?? [];
    if (!Array.isArray(ctorInputs) || ctorInputs.length !== 1) {
      throw new Error('AuthGuard artifact constructorInputs unexpected shape.');
    }

    const parsedArg = parseInputValue(`0x${tokenIdHex}`, ctorInputs[0].type);
    const c: any = new Contract(AUTHGUARD_ARTIFACT as any, [parsedArg], {
      provider,
      addressType: 'p2sh32',
    });

    const candidates: any[] = [
      c.lockingBytecode,
      c.lockingScript,
      typeof c.getLockingBytecode === 'function'
        ? c.getLockingBytecode()
        : null,
      typeof c.getLockingScript === 'function' ? c.getLockingScript() : null,
    ].filter(Boolean);

    const first = candidates[0];
    if (!first) throw new Error('Could not derive AuthGuard locking bytecode.');

    if (typeof first === 'string')
      return first.trim().toLowerCase().replace(/^0x/i, '');
    if (first instanceof Uint8Array) return bytesToHex(first);
    if (Array.isArray(first) && first.length && typeof first[0] === 'number') {
      return bytesToHex(Uint8Array.from(first));
    }
    if (first?.bytecode instanceof Uint8Array)
      return bytesToHex(first.bytecode);

    throw new Error('Could not normalize AuthGuard locking bytecode.');
  }

  const derivedAuthGuardAddress = useMemo(() => {
    try {
      if (!tokenId) return '';
      return deriveAuthGuardAddress(normalizeTokenIdTxid(tokenId));
    } catch {
      return '';
    }
  }, [tokenId]);

  const derivedAuthGuardTokenAddress = useMemo(() => {
    try {
      if (!tokenId) return '';
      return deriveAuthGuardTokenAddress(normalizeTokenIdTxid(tokenId));
    } catch {
      return '';
    }
  }, [tokenId]);

  const derivedAuthGuardLockingHex = useMemo(() => {
    try {
      if (!tokenId) return '';
      return deriveAuthGuardLockingBytecodeHex(normalizeTokenIdTxid(tokenId));
    } catch {
      return '';
    }
  }, [tokenId]);

  useEffect(() => {
    let mounted = true;
    (async () => {
      if (!derivedAuthGuardAddress) {
        if (mounted) setAuthGuardCashAddress('');
        return;
      }
      const cashAddr = await toCashTokenAddressBestEffort(
        currentWalletId(),
        derivedAuthGuardAddress
      );
      if (mounted) setAuthGuardCashAddress(cashAddr);
    })();
    return () => {
      mounted = false;
    };
  }, [derivedAuthGuardAddress]);

  useEffect(() => {
    let mounted = true;
    (async () => {
      if (!derivedAuthGuardTokenAddress) {
        if (mounted) setAuthGuardTokenAddress('');
        return;
      }
      const tokenAddr = await toCashTokenAddressBestEffort(
        currentWalletId(),
        derivedAuthGuardTokenAddress
      );
      if (mounted) setAuthGuardTokenAddress(tokenAddr);
    })();
    return () => {
      mounted = false;
    };
  }, [derivedAuthGuardTokenAddress]);

  // ---------------------------------------------------------------------------
  // IMPORTANT UX NOTE:
  // For a given category (tokenId), the FIRST SPEND of the genesis is the mint moment.
  // If you spend it to mint only AuthKey, you can’t mint FT supply later for that same category.
  // ---------------------------------------------------------------------------

  const firstSpendWarning = useMemo(() => {
    if (!tokenId) return '';
    if (!genesisUtxo) {
      // If tokenId derived from authKey, genesis may not be selected.
      return 'Reminder: initial minting happens on the FIRST spend of the category’s vout=0 genesis. If that spend already happened, you cannot create new supply for that category.';
    }
    return 'Reminder: initial minting happens on the FIRST spend of this selected vout=0 genesis. If you broadcast a tx that spends it without minting your desired supply, you cannot mint that supply later for this category.';
  }, [tokenId, genesisUtxo]);

  // ---------------------------------------------------------------------------
  // Step 0A: Create AuthKey NFT only (no FT reserve)
  // ---------------------------------------------------------------------------

  const createAuthKeyOnlyStep0A = useCallback(async () => {
    setBusy(true);
    setBuildErr('');
    setBuildHex('');
    setBuildBytes(0);
    setStep0AStatus('');

    try {
      const primary = await getPrimaryWalletAddress();

      const res0 = await sdk.utxos.listForWallet();
      const allUtxos0 = mergeWalletUtxos(res0);
      setWalletUtxos(allUtxos0);

      let genesis = genesisUtxo;

      // If user didn't pick a genesis, try find/create one for convenience
      if (!genesis) {
        genesis = findSuitableGenesisCandidate(allUtxos0, primary);
        if (!genesis) {
          const feeInput =
            feeUtxo ??
            allUtxos0.find(
              (u) => (u.value ?? 0) > MIN_GENESIS_SATS + 2000 && !u.token
            ) ??
            null;
          if (!feeInput) {
            throw new Error(
              `No suitable BCH UTXO found to create genesis candidate. Need > ${
                MIN_GENESIS_SATS + 2000
              } sats.`
            );
          }

          setStep0AStatus('Creating vout=0 genesis candidate (tx1)…');
          const outputs1: TransactionOutput[] = [
            { recipientAddress: primary, amount: MIN_GENESIS_SATS },
          ];
          const built1 = await buildTx([feeInput], outputs1, primary);
          const txid1 = await broadcastTx(built1.hex);

          setStep0AStatus(`tx1 broadcasted: ${txid1}. Refreshing UTXOs…`);

          const res1 = await sdk.utxos.listForWallet();
          const after1 = mergeWalletUtxos(res1);
          setWalletUtxos(after1);

          genesis =
            after1.find(
              (u) => u.tx_hash === txid1 && u.tx_pos === 0 && !u.token
            ) ?? null;

          if (!genesis) {
            throw new Error(
              'tx1 broadcasted, but genesis UTXO not visible yet. Try “Load Wallet UTXOs” and re-run.'
            );
          }

          setGenesisUtxo(genesis);
        } else {
          setGenesisUtxo(genesis);
        }
      } else {
        if (genesis.tx_pos !== 0 || genesis.token) {
          throw new Error('Selected genesis must be non-token and vout=0.');
        }
      }

      const tokenIdHex = normalizeTokenIdTxid(genesis!.tx_hash);

      const allow = await loadWalletAddresses();
      const ownerBase = (authKeyOwner || primary).trim();
      if (!ownerBase) throw new Error('AuthKey owner address is required.');
      if (!allow.has(ownerBase)) {
        throw new Error(
          'AuthKey owner must be one of your wallet addresses (wallet-controlled).'
        );
      }

      // If already exists, just select it
      const latest = mergeWalletUtxos(await sdk.utxos.listForWallet());
      const have = findAuthKeyForTokenId(latest, tokenIdHex, ownerBase);
      if (have) {
        setAuthKeyUtxo(have);
        setStep0AStatus('AuthKey already exists for this category.');
        return;
      }

      // Build the FIRST SPEND of genesis:
      // Mint ONLY AuthKey NFT to owner. No FT reserve output.
      // NOTE: This means you cannot mint FT supply later for this category.
      const ownerTokenAddr = await toCashTokenAddressBestEffort(
        currentWalletId(),
        ownerBase
      );

      const outputs: TransactionOutput[] = [
        {
          recipientAddress: ownerTokenAddr,
          amount: Math.max(Number(TOKEN_OUTPUT_SATS), Number(DUST)),
          token: {
            category: tokenIdHex,
            amount: 0n as any,
            nft: { capability: 'none', commitment: '' as any },
          },
        },
      ];

      const feeInput2 =
        feeUtxo ??
        allUtxos0.find(
          (u) => (u.value ?? 0) > 3000 && !u.token && u.address === primary
        ) ??
        allUtxos0.find((u) => (u.value ?? 0) > 3000 && !u.token) ??
        null;
      if (!feeInput2) throw new Error('No suitable BCH fee UTXO found.');

      const inputs =
        feeInput2.tx_hash === genesis!.tx_hash &&
        feeInput2.tx_pos === genesis!.tx_pos
          ? [genesis!]
          : [genesis!, feeInput2];

      setStep0AStatus('Minting AuthKey NFT (first spend of genesis)…');

      const built = await buildTx(inputs, outputs, ownerBase);
      const txid = await broadcastTx(built.hex);

      setStep0AStatus(`AuthKey tx broadcasted: ${txid}. Refreshing UTXOs…`);

      const res2 = await sdk.utxos.listForWallet();
      const after2 = mergeWalletUtxos(res2);
      setWalletUtxos(after2);

      // Refresh selection
      const k2 = after2.find((u) => {
        if (!u.token) return false;
        if (!tokenAmountIsZero(u.token)) return false;
        if (!u.token.nft) return false;
        if (u.token.nft.capability !== 'none') return false;
        return (
          normalizeCategory(u.token.category) === normalizeCategory(tokenIdHex)
        );
      });
      if (k2) setAuthKeyUtxo(k2);

      setStep0AStatus(
        'Step 0A complete. AuthKey minted. (Note: no FT supply was created for this category.)'
      );
    } catch (e: any) {
      setBuildErr(e?.message ?? String(e));
      setStep0AStatus('');
    } finally {
      setBusy(false);
    }
  }, [
    sdk,
    loadWalletAddresses,
    feeUtxo,
    MIN_GENESIS_SATS,
    authKeyOwner,
    genesisUtxo,
  ]);

  // ---------------------------------------------------------------------------
  // Step 0B: Mint token (FT or NFT) from selected vout=0 to a recipient
  // - default recipient: AuthGuard tokenaddr
  // - can optionally mint AuthKey in SAME tx (recommended for AuthGuard-protected categories)
  // ---------------------------------------------------------------------------

  function validateHexEven(x: string) {
    const s = String(x ?? '')
      .trim()
      .toLowerCase()
      .replace(/^0x/i, '');
    if (!s) return '';
    if (!/^[0-9a-f]*$/.test(s)) {
      throw new Error('NFT commitment must be hex.');
    }
    if (s.length % 2 !== 0) {
      throw new Error('NFT commitment hex must have even length.');
    }
    return s;
  }

  const mintTokenStep0B = useCallback(async () => {
    setBusy(true);
    setBuildErr('');
    setBuildHex('');
    setBuildBytes(0);
    setStep0BStatus('');

    try {
      const primary = await getPrimaryWalletAddress();

      const res0 = await sdk.utxos.listForWallet();
      const allUtxos0 = mergeWalletUtxos(res0);
      setWalletUtxos(allUtxos0);

      const genesis = genesisUtxo;
      if (!genesis) {
        throw new Error(
          'Select a vout=0 non-token genesis UTXO (TokenId) first.'
        );
      }
      if (genesis.tx_pos !== 0 || genesis.token) {
        throw new Error('Selected genesis must be non-token and vout=0.');
      }

      const tokenIdHex = normalizeTokenIdTxid(genesis.tx_hash);

      // Choose mint recipient
      let mintRecipientBase = '';
      if (mintTarget === 'authguard') {
        mintRecipientBase =
          authGuardTokenAddress ||
          (await toCashTokenAddressBestEffort(
            currentWalletId(),
            deriveAuthGuardTokenAddress(tokenIdHex)
          ));
      } else {
        mintRecipientBase = mintTo.trim();
        if (!mintRecipientBase) throw new Error('Mint-to address is required.');
      }

      const mintRecipient = await toCashTokenAddressBestEffort(
        currentWalletId(),
        mintRecipientBase
      );

      // Optional AuthKey minted in same tx (recommended if this category will be guarded)
      let ownerBase = '';
      let ownerTokenAddr = '';
      if (mintAlsoAuthKey) {
        const allow = await loadWalletAddresses();
        ownerBase = (authKeyOwner || primary).trim();
        if (!ownerBase) throw new Error('AuthKey owner address is required.');
        if (!allow.has(ownerBase)) {
          throw new Error(
            'AuthKey owner must be one of your wallet addresses (wallet-controlled).'
          );
        }
        ownerTokenAddr = await toCashTokenAddressBestEffort(
          currentWalletId(),
          ownerBase
        );
      }

      // Build outputs
      const outputs: TransactionOutput[] = [];

      if (mintType === 'ft') {
        const amt = toBigIntSafe(mintFtAmount);
        if (amt <= 0n) throw new Error('FT amount must be a positive integer.');

        // (optional) AuthKey NFT output
        if (mintAlsoAuthKey) {
          outputs.push({
            recipientAddress: ownerTokenAddr,
            amount: Math.max(Number(TOKEN_OUTPUT_SATS), Number(DUST)),
            token: {
              category: tokenIdHex,
              amount: 0n as any,
              nft: { capability: 'none', commitment: '' as any },
            },
          });
        }

        // FT supply output to mintRecipient (tokenaddr)
        outputs.push({
          recipientAddress: mintRecipient,
          amount: Math.max(Number(TOKEN_OUTPUT_SATS), Number(DUST)),
          token: { category: tokenIdHex, amount: amt as any },
        });
      } else {
        // NFT mint
        const commitment = validateHexEven(mintNftCommitment);
        const nft = {
          capability: mintNftCapability,
          commitment: commitment as any,
        };

        // (optional) AuthKey NFT output
        if (mintAlsoAuthKey) {
          outputs.push({
            recipientAddress: ownerTokenAddr,
            amount: Math.max(Number(TOKEN_OUTPUT_SATS), Number(DUST)),
            token: {
              category: tokenIdHex,
              amount: 0n as any,
              nft: { capability: 'none', commitment: '' as any },
            },
          });
        }

        outputs.push({
          recipientAddress: mintRecipient,
          amount: Math.max(Number(TOKEN_OUTPUT_SATS), Number(DUST)),
          token: {
            category: tokenIdHex,
            amount: 0n as any,
            nft: nft as any,
          },
        });
      }

      // Inputs: genesis + fee input (unless fee input == genesis)
      const feeInput =
        feeUtxo ??
        allUtxos0.find(
          (u) => (u.value ?? 0) > 3000 && !u.token && u.address === primary
        ) ??
        allUtxos0.find((u) => (u.value ?? 0) > 3000 && !u.token) ??
        null;
      if (!feeInput) throw new Error('No suitable BCH fee UTXO found.');

      const inputs =
        feeInput.tx_hash === genesis.tx_hash &&
        feeInput.tx_pos === genesis.tx_pos
          ? [genesis]
          : [genesis, feeInput];

      setStep0BStatus(
        `Minting ${mintType.toUpperCase()} (first spend of genesis)…`
      );

      // Change address should be a wallet-controlled address.
      // Use the primary cashaddr base, builder handles change output.
      const built = await buildTx(inputs, outputs, primary);
      const txid = await broadcastTx(built.hex);

      setStep0BStatus(`Mint tx broadcasted: ${txid}. Refreshing UTXOs…`);

      const res2 = await sdk.utxos.listForWallet();
      const after2 = mergeWalletUtxos(res2);
      setWalletUtxos(after2);

      // If AuthKey minted here, attempt to auto-select it
      if (mintAlsoAuthKey) {
        const allow = await loadWalletAddresses();
        const owner = (authKeyOwner || primary).trim();
        if (owner && allow.has(owner)) {
          const k2 = after2.find((u) => {
            if (!u.token) return false;
            if (!tokenAmountIsZero(u.token)) return false;
            if (!u.token.nft) return false;
            if (u.token.nft.capability !== 'none') return false;
            return (
              normalizeCategory(u.token.category) ===
              normalizeCategory(tokenIdHex)
            );
          });
          if (k2) setAuthKeyUtxo(k2);
        }
      }

      // If minted to AuthGuard, you can now discover AuthHead via Chaingraph
      setAuthHeadUtxo(null);
      setAuthHeadCandidatesChain([]);

      setStep0BStatus(
        mintTarget === 'authguard'
          ? 'Mint complete. If you minted FT to AuthGuard, click “Load AuthHead (Chaingraph)” below.'
          : 'Mint complete.'
      );
    } catch (e: any) {
      setBuildErr(e?.message ?? String(e));
      setStep0BStatus('');
    } finally {
      setBusy(false);
    }
  }, [
    sdk,
    loadWalletAddresses,
    feeUtxo,
    genesisUtxo,
    mintType,
    mintTarget,
    mintTo,
    mintFtAmount,
    mintNftCapability,
    mintNftCommitment,
    mintAlsoAuthKey,
    authKeyOwner,
    authGuardTokenAddress,
  ]);

  // ---------------------------------------------------------------------------
  // Chaingraph: discover AuthHead candidates for selected tokenId
  // ---------------------------------------------------------------------------

  const loadAuthHeadFromChaingraph = useCallback(async () => {
    setAuthHeadStatus('');
    setBuildErr('');

    try {
      if (!tokenId) {
        setAuthHeadStatus('Select TokenId (genesis vout=0) first.');
        return;
      }

      setAuthHeadStatus('Deriving AuthGuard locking bytecode…');

      const lockingHex = deriveAuthGuardLockingBytecodeHex(tokenId);

      setAuthHeadStatus('Querying Chaingraph for unspent AuthHead candidates…');

      const resp = await queryUnspentOutputsByLockingBytecode(
        lockingHex,
        tokenId
      );
      if (resp.errors) {
        throw new Error(`Chaingraph errors: ${JSON.stringify(resp.errors)}`);
      }

      const rows = resp.data?.output ?? [];
      const mapped: UTXO[] = rows.map((r) => {
        const tx_hash = stripChaingraphHexBytes(r.transaction_hash);
        const tx_pos = Number(r.output_index ?? 0);
        const value = Number(r.value_satoshis ?? 0);

        const category = r.token_category
          ? stripChaingraphHexBytes(r.token_category)
          : '';

        const fungible = r.fungible_token_amount ?? null;
        const ftAmt = fungible === null ? 0n : toBigIntSafe(fungible);

        const cap = r.nonfungible_token_capability ?? null;
        const commitment = r.nonfungible_token_commitment
          ? stripChaingraphHexBytes(r.nonfungible_token_commitment)
          : '';

        const token =
          category && (ftAmt > 0n || cap)
            ? ({
                category,
                amount: ftAmt,
                ...(cap
                  ? {
                      nft: {
                        capability: cap as any,
                        commitment,
                      },
                    }
                  : {}),
              } as any)
            : null;

        const out: UTXO = {
          id: `${tx_hash}:${tx_pos}`,
          address:
            authGuardTokenAddress ||
            authGuardCashAddress ||
            deriveAuthGuardTokenAddress(normalizeTokenIdTxid(tokenId)),
          tx_hash,
          tx_pos,
          value,
          amount: value,
          height: 0,
          prefix: undefined,
          token: token as any,
          contractName: 'AuthGuard',
          abi: (AUTHGUARD_ARTIFACT as any).abi,
        };

        return out;
      });

      const deduped = uniqUtxos(mapped);
      setAuthHeadCandidatesChain(deduped);

      if (deduped.length === 0) {
        setAuthHeadStatus(
          'No unspent AuthHead candidates found on Chaingraph.'
        );
      } else {
        setAuthHeadStatus(`Found ${deduped.length} candidate(s).`);
        if (!authHeadUtxo) setAuthHeadUtxo(deduped[0]);
      }
    } catch (e: any) {
      setAuthHeadStatus('');
      setBuildErr(e?.message ?? String(e));
    }
  }, [tokenId, authHeadUtxo, authGuardCashAddress, authGuardTokenAddress]);

  // ---------------------------------------------------------------------------
  // Existing smoke test
  // ---------------------------------------------------------------------------

  const buildSendToSelf = useCallback(async () => {
    setBusy(true);
    setBuildErr('');
    setBuildHex('');
    setBuildBytes(0);

    try {
      const allow = await loadWalletAddresses();
      const to = [...allow][0];
      if (!to)
        throw new Error('No wallet addresses found (cannot do send-to-self).');

      const utxo = selected;
      if (!utxo) throw new Error('No UTXO selected.');

      const outputs: TransactionOutput[] = [
        { recipientAddress: to, amount: 600 },
      ];

      const res = await sdk.tx.build({
        inputs: [utxo],
        outputs,
        changeAddress: to,
      });
      if (res.errorMsg) throw new Error(res.errorMsg);

      setBuildHex(res.hex || '');
      setBuildBytes(res.bytes || 0);
    } catch (e: any) {
      setBuildErr(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }, [sdk, selected, loadWalletAddresses]);

  // ---------------------------------------------------------------------------
  // Build AuthGuard dispense (FT transfer from AuthHead reserve)
  // ---------------------------------------------------------------------------

  const buildIssueFt = useCallback(async () => {
    setBusy(true);
    setBuildErr('');
    setBuildHex('');
    setBuildBytes(0);

    try {
      const allow = await loadWalletAddresses();
      const changeAddr = [...allow][0];
      if (!changeAddr) throw new Error('No wallet address found for change.');

      if (!tokenId) {
        throw new Error(
          'TokenId missing. Select a genesis UTXO (vout=0, non-token) or select an AuthKey (category).'
        );
      }
      const tokenIdNorm = normalizeTokenIdTxid(tokenId);

      const head = authHeadUtxo;
      if (!head)
        throw new Error('Select an AuthHead UTXO (AuthGuard contract UTXO).');

      const key = authKeyUtxo;
      if (!key) throw new Error('Select an AuthKey NFT UTXO.');

      if (!key.token) throw new Error('AuthKey must be a token UTXO (NFT).');
      if (!tokenAmountIsZero(key.token)) {
        throw new Error('AuthKey must be NFT-only (token amount must be 0).');
      }

      const fee = feeUtxo;
      if (!fee) throw new Error('Select a BCH fee UTXO.');
      if (fee.token) throw new Error('Fee UTXO must be non-token.');

      const to = recipient.trim();
      if (!to) throw new Error('Recipient address is required.');
      const toTokenAddr = await toCashTokenAddressBestEffort(
        currentWalletId(),
        to
      );

      const sendAmt = toBigIntSafe(ftAmount);
      if (sendAmt <= 0n)
        throw new Error('FT amount must be a positive integer.');

      const headToken = head.token;
      if (!headToken?.category)
        throw new Error('AuthHead UTXO has no token attached.');

      const headCat = normalizeCategory(headToken.category);
      const expected = tokenIdNorm;
      if (headCat !== expected) {
        throw new Error(
          `AuthHead token category mismatch. expected=${tokenIdNorm} got=${String(
            headToken.category
          )}`
        );
      }

      const headAmt = toBigIntSafe((headToken as any).amount ?? 0);
      if (headAmt < sendAmt) {
        throw new Error(
          `Insufficient reserved supply at AuthHead. have=${headAmt.toString()} need=${sendAmt.toString()}`
        );
      }

      const remaining = headAmt - sendAmt;

      const outputs: TransactionOutput[] = [];

      // Continue reserve back to AuthGuard token address
      outputs.push({
        recipientAddress:
          authGuardTokenAddress ||
          (await toCashTokenAddressBestEffort(currentWalletId(), head.address)),
        amount: Math.max(Number(TOKEN_OUTPUT_SATS), Number(DUST)),
        ...(remaining > 0n
          ? { token: { category: tokenIdNorm, amount: remaining } }
          : {}),
      });

      // Recipient gets FT
      outputs.push({
        recipientAddress: toTokenAddr,
        amount: Math.max(Number(TOKEN_OUTPUT_SATS), Number(DUST)),
        token: { category: tokenIdNorm, amount: sendAmt },
      });

      const headInput: UTXO = {
        ...head,
        contractName: 'AuthGuard',
        abi: (head as any).abi ?? (AUTHGUARD_ARTIFACT as any).abi,
        contractFunction: 'unlockWithNft',
        contractConstructorArgs: [`0x${tokenIdNorm}`],
        contractFunctionInputs: { keepGuarded },
      };

      // STRICT ordering: inputs[1] must be AuthKey NFT
      const inputs: UTXO[] = [headInput, key, fee];

      const res = await sdk.tx.build({
        inputs,
        outputs,
        changeAddress: changeAddr,
      });
      if (res.errorMsg) throw new Error(res.errorMsg);

      setBuildHex(res.hex || '');
      setBuildBytes(res.bytes || 0);
    } catch (e: any) {
      setBuildErr(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }, [
    sdk,
    loadWalletAddresses,
    tokenId,
    authHeadUtxo,
    authKeyUtxo,
    feeUtxo,
    recipient,
    ftAmount,
    keepGuarded,
    authGuardTokenAddress,
  ]);

  // ---------------------------------------------------------------------------
  // Lists for wizard selection
  // ---------------------------------------------------------------------------

  const genesisCandidates = useMemo(() => {
    return walletUtxos.filter((u) => !u.token && u.tx_pos === 0);
  }, [walletUtxos]);

  const authKeyCandidates = useMemo(() => {
    const t = tokenId ? normalizeCategory(tokenId) : '';
    return walletUtxos.filter((u) => {
      if (!u.token) return false;
      if (!tokenAmountIsZero(u.token)) return false;
      if (!t) return true;
      return normalizeCategory(u.token.category) === t;
    });
  }, [walletUtxos, tokenId]);

  const authHeadCandidates = useMemo(() => {
    const t = tokenId ? normalizeCategory(tokenId) : '';

    const walletMatches = walletUtxos.filter((u) => {
      const isTagged =
        String((u as any).contractName ?? '').toLowerCase() === 'authguard' ||
        (Array.isArray((u as any).abi) &&
          (u as any).abi.some((f: any) => f?.name === 'unlockWithNft'));

      const tokenMatch =
        !!t && !!u.token?.category && normalizeCategory(u.token.category) === t;

      return isTagged || tokenMatch;
    });

    return uniqUtxos([
      ...(walletMatches ?? []),
      ...(authHeadCandidatesChain ?? []),
    ]);
  }, [walletUtxos, tokenId, authHeadCandidatesChain]);

  const feeCandidates = useMemo(() => {
    return walletUtxos.filter(
      (u) => !u.token && !u.contractName && !u.abi && (u.value ?? 0) > 1000
    );
  }, [walletUtxos]);

  const dispenseMissing = useMemo(() => {
    const missing: string[] = [];
    if (!tokenId) missing.push('TokenId (genesis vout=0) is not selected.');
    if (!authHeadUtxo) missing.push('AuthHead UTXO is not selected.');
    if (!authKeyUtxo) missing.push('AuthKey NFT UTXO is not selected.');
    if (!feeUtxo) missing.push('Fee UTXO is not selected.');
    if (!recipient.trim()) missing.push('Recipient address is missing.');
    return missing;
  }, [tokenId, authHeadUtxo, authKeyUtxo, feeUtxo, recipient]);

  const dispenseDisabled = useMemo(() => {
    return busy || dispenseMissing.length > 0;
  }, [busy, dispenseMissing.length]);

  const renderUtxoRow = (
    u: UTXO,
    isSelected: boolean,
    onPick: () => void,
    subline?: string
  ) => {
    const key = `${u.tx_hash}:${u.tx_pos}`;
    return (
      <div
        key={key}
        onClick={onPick}
        className={`p-2 text-sm cursor-pointer border-b last:border-b-0 ${
          isSelected ? 'bg-blue-50' : 'hover:bg-gray-50'
        }`}
      >
        <div className="flex justify-between">
          <div className="font-mono">
            {u.tx_hash.slice(0, 10)}…:{u.tx_pos}
          </div>
          <div className="font-semibold">{u.value} sats</div>
        </div>

        {subline ? (
          <div className="text-xs text-gray-600">{subline}</div>
        ) : u.token ? (
          <div className="text-xs text-orange-700">
            Token UTXO (category: {String(u.token.category)}) amt:{' '}
            {String((u.token as any).amount ?? '')}
          </div>
        ) : (
          <div className="text-xs text-gray-500">Regular BCH UTXO</div>
        )}

        {(u as any).contractName && (
          <div className="text-xs text-purple-700">
            contract: {String((u as any).contractName)}
          </div>
        )}
      </div>
    );
  };

  const pickGenesis = useCallback((u: UTXO) => {
    try {
      if (u.tx_pos !== 0 || !!u.token) {
        throw new Error('Genesis must be a non-token UTXO with tx_pos==0.');
      }
      normalizeTokenIdTxid(u.tx_hash);
      setGenesisUtxo(u);
      setBuildErr('');
    } catch (e: any) {
      setBuildErr(e?.message ?? String(e));
    }
  }, []);

  // ---------------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------------

  return (
    <div className="border rounded-lg p-4 shadow-sm">
      <div className="text-sm text-gray-600 mb-2">
        <span className="font-semibold">Addon:</span> {manifest.id}{' '}
        <span className="mx-2">•</span>
        <span className="font-semibold">Version:</span> {manifest.version}
      </div>

      <div className="flex gap-2 mb-4">
        <button
          disabled={busy}
          onClick={refreshWalletUtxos}
          className="bg-blue-500 hover:bg-blue-600 disabled:opacity-50 text-white py-2 px-3 rounded"
        >
          Load Wallet UTXOs
        </button>

        <button
          disabled={busy || !selected}
          onClick={buildSendToSelf}
          className="bg-green-500 hover:bg-green-600 disabled:opacity-50 text-white py-2 px-3 rounded"
        >
          Build Send-to-Self (Smoke Test)
        </button>
      </div>

      {/* AuthGuard v1 Wizard */}
      <div className="border rounded p-3 mb-4">
        <div className="font-semibold mb-2">AuthGuard v1</div>

        {/* --- WARNING --- */}
        {firstSpendWarning && (
          <div className="mb-3 p-2 rounded border bg-yellow-50 text-xs text-yellow-800">
            <div className="font-semibold mb-1">Minting nuance</div>
            <div>{firstSpendWarning}</div>
          </div>
        )}

        {/* STEP 0A: Create AuthKey only */}
        <div className="border rounded p-3 mb-4 bg-gray-50">
          <div className="font-semibold mb-1">
            Step 0A — Create AuthKey NFT (optional)
          </div>
          <div className="text-xs text-gray-600 mb-3">
            This is only needed if you want{' '}
            <span className="font-semibold">
              AuthGuard-protected dispensing
            </span>
            .
            <br />
            It mints an <span className="font-semibold">
              NFT-only AuthKey
            </span>{' '}
            (amount=0, capability=none).
            <br />
            <span className="font-semibold">
              If you mint AuthKey but do not mint FT supply in the same tx, you
              cannot mint FT later for that category.
            </span>
          </div>

          <div className="grid gap-2">
            <label className="text-xs text-gray-600">
              AuthKey owner address (must be wallet-controlled)
              <input
                className="mt-1 w-full border rounded p-2 text-sm"
                value={authKeyOwner}
                onChange={(e) => setAuthKeyOwner(e.target.value)}
                placeholder="bchtest:... (one of your wallet addresses)"
              />
            </label>

            <button
              disabled={busy}
              onClick={createAuthKeyOnlyStep0A}
              className="bg-purple-700 hover:bg-purple-800 disabled:opacity-50 text-white py-2 px-3 rounded"
            >
              Create AuthKey NFT Only
            </button>

            {step0AStatus && (
              <div className="text-xs text-gray-700">
                <span className="font-semibold">Status:</span> {step0AStatus}
              </div>
            )}
          </div>
        </div>

        {/* STEP 0B: Mint tokens (FT or NFT) */}
        <div className="border rounded p-3 mb-4 bg-gray-50">
          <div className="font-semibold mb-1">
            Step 0B — Mint Token (FT or NFT)
          </div>
          <div className="text-xs text-gray-600 mb-3">
            Mint from a wallet <span className="font-mono">vout=0</span> UTXO
            (category anchor). You can mint to{' '}
            <span className="font-semibold">AuthGuard tokenaddr</span> (default)
            or any tokenaddr.
            <br />
            Optional: mint AuthKey in the{' '}
            <span className="font-semibold">same transaction</span> (recommended
            for guarded categories).
          </div>

          <div className="grid gap-3">
            <div className="flex flex-wrap gap-3 text-sm">
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  checked={mintType === 'ft'}
                  onChange={() => setMintType('ft')}
                />
                FT
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  checked={mintType === 'nft'}
                  onChange={() => setMintType('nft')}
                />
                NFT
              </label>
            </div>

            {mintType === 'ft' ? (
              <label className="text-xs text-gray-600">
                FT amount (integer)
                <input
                  className="mt-1 w-full border rounded p-2 text-sm font-mono"
                  value={mintFtAmount}
                  onChange={(e) => setMintFtAmount(e.target.value)}
                  placeholder="1000000"
                />
              </label>
            ) : (
              <div className="grid gap-2">
                <label className="text-xs text-gray-600">
                  NFT capability
                  <select
                    className="mt-1 w-full border rounded p-2 text-sm"
                    value={mintNftCapability}
                    onChange={(e) =>
                      setMintNftCapability(e.target.value as any)
                    }
                  >
                    <option value="none">none</option>
                    <option value="mutable">mutable</option>
                    <option value="minting">minting</option>
                  </select>
                </label>

                <label className="text-xs text-gray-600">
                  NFT commitment (hex, optional)
                  <input
                    className="mt-1 w-full border rounded p-2 text-sm font-mono"
                    value={mintNftCommitment}
                    onChange={(e) => setMintNftCommitment(e.target.value)}
                    placeholder="(hex bytes, even length)"
                  />
                </label>
              </div>
            )}

            <div className="flex flex-wrap gap-3 text-sm">
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  checked={mintTarget === 'authguard'}
                  onChange={() => setMintTarget('authguard')}
                />
                Mint to AuthGuard (recommended)
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  checked={mintTarget === 'custom'}
                  onChange={() => setMintTarget('custom')}
                />
                Mint to custom token address
              </label>
            </div>

            {mintTarget === 'custom' && (
              <label className="text-xs text-gray-600">
                Mint-to address (tokenaddr recommended)
                <input
                  className="mt-1 w-full border rounded p-2 text-sm"
                  value={mintTo}
                  onChange={(e) => setMintTo(e.target.value)}
                  placeholder="bitcoincash:z... or bchtest:z..."
                />
              </label>
            )}

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={mintAlsoAuthKey}
                onChange={(e) => setMintAlsoAuthKey(e.target.checked)}
              />
              Also mint AuthKey NFT in this same transaction
            </label>

            {mintAlsoAuthKey && (
              <label className="text-xs text-gray-600">
                AuthKey owner address (must be wallet-controlled)
                <input
                  className="mt-1 w-full border rounded p-2 text-sm"
                  value={authKeyOwner}
                  onChange={(e) => setAuthKeyOwner(e.target.value)}
                  placeholder="bchtest:... (one of your wallet addresses)"
                />
              </label>
            )}

            <button
              disabled={busy || !genesisUtxo}
              onClick={mintTokenStep0B}
              className="bg-purple-700 hover:bg-purple-800 disabled:opacity-50 text-white py-2 px-3 rounded"
              title={
                !genesisUtxo
                  ? 'Select a genesis UTXO (vout=0) first.'
                  : undefined
              }
            >
              Mint Token (First Spend)
            </button>

            {step0BStatus && (
              <div className="text-xs text-gray-700">
                <span className="font-semibold">Status:</span> {step0BStatus}
              </div>
            )}

            {tokenId && (
              <div className="text-xs space-y-1">
                <div>
                  <span className="font-semibold">tokenId/category:</span>{' '}
                  <span className="font-mono">{tokenId}</span>
                </div>

                {derivedAuthGuardAddress && (
                  <div>
                    <span className="font-semibold">AuthGuard cashaddr:</span>{' '}
                    <span className="font-mono break-all">
                      {authGuardCashAddress || derivedAuthGuardAddress}
                    </span>
                  </div>
                )}

                {authGuardTokenAddress && (
                  <div>
                    <span className="font-semibold">AuthGuard tokenaddr:</span>{' '}
                    <span className="font-mono break-all">
                      {authGuardTokenAddress}
                    </span>
                  </div>
                )}
              </div>
            )}

            {tokenId && derivedAuthGuardLockingHex && (
              <div className="text-xs">
                <span className="font-semibold">
                  AuthGuard locking bytecode:
                </span>{' '}
                <span className="font-mono break-all">
                  {derivedAuthGuardLockingHex}
                </span>
              </div>
            )}
          </div>
        </div>

        <div className="text-xs text-gray-600 mb-3">
          Requirements enforced:
          <ul className="list-disc ml-5 mt-1">
            <li>inputs[1] must be the AuthKey NFT (tokenAmount=0)</li>
            <li>
              keepGuarded=true ⇒ outputs[0] must preserve the AuthHead locking
              bytecode
            </li>
          </ul>
        </div>

        <div className="grid gap-3">
          {/* 1) TokenId */}
          <div>
            <div className="text-sm font-semibold mb-1">
              1) TokenId (Genesis UTXO vout=0)
            </div>
            <div className="text-xs text-gray-600 mb-2">
              Pick a non-token UTXO where tx_pos==0. tokenId = tx_hash.
            </div>

            <div className="max-h-40 overflow-y-auto border rounded">
              {genesisCandidates.length === 0 ? (
                <div className="p-2 text-xs text-gray-500">
                  No genesis candidates found.
                </div>
              ) : (
                genesisCandidates
                  .slice(0, 50)
                  .map((u) =>
                    renderUtxoRow(
                      u,
                      !!genesisUtxo &&
                        genesisUtxo.tx_hash === u.tx_hash &&
                        genesisUtxo.tx_pos === u.tx_pos,
                      () => pickGenesis(u),
                      'Genesis candidate (tx_pos=0)'
                    )
                  )
              )}
            </div>

            <div className="mt-2 text-xs">
              <span className="font-semibold">tokenId:</span>{' '}
              <span className="font-mono">{tokenId ?? '(not selected)'}</span>
            </div>
          </div>

          {/* 2) AuthHead */}
          <div>
            <div className="text-sm font-semibold mb-1">2) AuthHead UTXO</div>
            <div className="text-xs text-gray-600 mb-2">
              Select the AuthGuard contract UTXO holding reserved supply
              (token.category == tokenId). (In practice: discover via
              Chaingraph.)
            </div>

            <div className="flex items-center gap-2 mb-2">
              <button
                disabled={busy || !tokenId}
                onClick={loadAuthHeadFromChaingraph}
                className="bg-gray-900 hover:bg-black disabled:opacity-50 text-white py-1.5 px-3 rounded text-xs"
                title={!tokenId ? 'Select a tokenId first.' : undefined}
              >
                Load AuthHead (Chaingraph)
              </button>

              {authHeadStatus && (
                <div className="text-xs text-gray-700">{authHeadStatus}</div>
              )}
            </div>

            <div className="max-h-40 overflow-y-auto border rounded">
              {authHeadCandidates.length === 0 ? (
                <div className="p-2 text-xs text-gray-500">
                  No authHead candidates found.
                </div>
              ) : (
                authHeadCandidates
                  .slice(0, 50)
                  .map((u) =>
                    renderUtxoRow(
                      u,
                      !!authHeadUtxo &&
                        authHeadUtxo.tx_hash === u.tx_hash &&
                        authHeadUtxo.tx_pos === u.tx_pos,
                      () => setAuthHeadUtxo(u),
                      u.token
                        ? `token.category=${String(u.token.category)} amt=${String(
                            (u.token as any).amount ?? ''
                          )}`
                        : 'no token'
                    )
                  )
              )}
            </div>
          </div>

          {/* 3) AuthKey */}
          <div>
            <div className="text-sm font-semibold mb-1">
              3) AuthKey NFT UTXO
            </div>
            <div className="text-xs text-gray-600 mb-2">
              Select an NFT-only UTXO where token.amount == 0 and token.category
              == tokenId.
            </div>

            <div className="max-h-40 overflow-y-auto border rounded">
              {authKeyCandidates.length === 0 ? (
                <div className="p-2 text-xs text-gray-500">
                  No AuthKey candidates found.
                </div>
              ) : (
                authKeyCandidates
                  .slice(0, 50)
                  .map((u) =>
                    renderUtxoRow(
                      u,
                      !!authKeyUtxo &&
                        authKeyUtxo.tx_hash === u.tx_hash &&
                        authKeyUtxo.tx_pos === u.tx_pos,
                      () => setAuthKeyUtxo(u),
                      `NFT-only (amount=0) • category=${String(u.token?.category)}`
                    )
                  )
              )}
            </div>
          </div>

          {/* 4) Fee */}
          <div>
            <div className="text-sm font-semibold mb-1">4) Fee UTXO</div>
            <div className="text-xs text-gray-600 mb-2">
              Pick a plain BCH UTXO to pay fees (no token, not a contract).
            </div>

            <div className="max-h-32 overflow-y-auto border rounded">
              {feeCandidates.length === 0 ? (
                <div className="p-2 text-xs text-gray-500">
                  No fee candidates found.
                </div>
              ) : (
                feeCandidates
                  .slice(0, 50)
                  .map((u) =>
                    renderUtxoRow(
                      u,
                      !!feeUtxo &&
                        feeUtxo.tx_hash === u.tx_hash &&
                        feeUtxo.tx_pos === u.tx_pos,
                      () => setFeeUtxo(u),
                      'Fee input'
                    )
                  )
              )}
            </div>
          </div>

          {/* 5) Dispense */}
          <div className="grid gap-2">
            <div className="text-sm font-semibold">
              5) Dispense (AuthGuard → Recipient)
            </div>

            <label className="text-xs text-gray-600">
              Recipient Address (tokenaddr recommended)
              <input
                className="mt-1 w-full border rounded p-2 text-sm"
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
                placeholder="bitcoincash:... or bchtest:..."
              />
            </label>

            <label className="text-xs text-gray-600">
              FT Amount (integer)
              <input
                className="mt-1 w-full border rounded p-2 text-sm font-mono"
                value={ftAmount}
                onChange={(e) => setFtAmount(e.target.value)}
                placeholder="1"
              />
            </label>

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={keepGuarded}
                onChange={(e) => setKeepGuarded(e.target.checked)}
              />
              keepGuarded (default true)
            </label>

            {dispenseMissing.length > 0 && (
              <div className="text-xs text-red-600 space-y-1">
                {dispenseMissing.map((m) => (
                  <div key={m}>• {m}</div>
                ))}
              </div>
            )}

            <button
              disabled={dispenseDisabled}
              onClick={buildIssueFt}
              className="bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white py-2 px-3 rounded"
              title={
                dispenseMissing.length
                  ? `Missing: ${dispenseMissing.join(' ')}`
                  : undefined
              }
            >
              Build Dispense (FT)
            </button>

            <div className="text-xs text-gray-500">
              Output[0] is always the AuthHead continuation; change is
              auto-added by the host builder.
            </div>
          </div>
        </div>
      </div>

      {buildErr && (
        <div className="text-red-600 text-sm mb-3">
          <div className="font-semibold">Error</div>
          <div>{buildErr}</div>
        </div>
      )}

      {buildHex && (
        <div className="mt-2">
          <div className="font-semibold mb-1">Built Transaction</div>
          <div className="text-sm text-gray-600 mb-2">bytes: {buildBytes}</div>
          <textarea
            className="w-full h-40 p-2 border rounded font-mono text-xs"
            value={buildHex}
            readOnly
          />
          <div className="text-xs text-gray-500 mt-2">
            Build-only UX. Broadcast happens only in actions that explicitly
            call broadcastTx().
          </div>
        </div>
      )}
    </div>
  );
}
