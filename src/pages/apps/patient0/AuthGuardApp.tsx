// src/pages/apps/patient0/AuthGuardApp.tsx

import { useCallback, useMemo, useState } from 'react';
import type { AddonManifest, AddonAppDefinition } from '../../../types/addons';
import type { AddonSDK } from '../../../services/AddonsSDK';
import type { UTXO, TransactionOutput, Token } from '../../../types/types';

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

/**
 * Normalize sdk.utxos.listForWallet() return shape.
 * Some implementations return { allUtxos } only, others return { allUtxos, tokenUtxos }.
 */
function mergeWalletUtxos(res: any): UTXO[] {
  const all: UTXO[] = Array.isArray(res?.allUtxos) ? res.allUtxos : [];
  const tok: UTXO[] = Array.isArray(res?.tokenUtxos) ? res.tokenUtxos : [];
  const tok2: UTXO[] = Array.isArray(res?.cashTokenUtxos)
    ? res.cashTokenUtxos
    : [];
  return uniqUtxos([...(all ?? []), ...(tok ?? []), ...(tok2 ?? [])]);
}

export default function AuthGuardApp({
  manifest,
  sdk,
  loadWalletAddresses,
}: Props) {
  const [walletUtxos, setWalletUtxos] = useState<UTXO[]>([]);
  const [selected, setSelected] = useState<UTXO | null>(null);

  // AuthGuard v1 (patient-0) states
  const [genesisUtxo, setGenesisUtxo] = useState<UTXO | null>(null);
  const [authHeadUtxo, setAuthHeadUtxo] = useState<UTXO | null>(null);
  const [authKeyUtxo, setAuthKeyUtxo] = useState<UTXO | null>(null);

  const [recipient, setRecipient] = useState<string>('');
  const [ftAmount, setFtAmount] = useState<string>('1'); // bigint string
  const [keepGuarded, setKeepGuarded] = useState<boolean>(true);

  // Step 0 (Create Token) state
  const [reserveSupply, setReserveSupply] = useState<string>('1000000'); // bigint string
  const [step0Status, setStep0Status] = useState<string>('');

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

  // ---------------------------------------------------------------------------
  // Derived values
  // ---------------------------------------------------------------------------

  const tokenId: string | null = useMemo(() => {
    // Preferred: explicitly selected genesis UTXO (vout=0 non-token)
    if (genesisUtxo && genesisUtxo.tx_pos === 0 && !genesisUtxo.token) {
      return genesisUtxo.tx_hash;
    }
    // fallback: infer from authHead token category if present
    if (authHeadUtxo?.token?.category)
      return String(authHeadUtxo.token.category);
    return null;
  }, [genesisUtxo, authHeadUtxo]);

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

      // default fee pick
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
  ): UTXO | null {
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

  /**
   * Derive the *locking bytecode hex* for the AuthGuard contract address.
   * We try multiple CashScript shapes to stay robust across versions.
   */
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

    // Try common CashScript properties/methods:
    const candidates: any[] = [
      c.lockingBytecode,
      c.lockingScript,
      typeof c.getLockingBytecode === 'function'
        ? c.getLockingBytecode()
        : null,
      typeof c.getLockingScript === 'function' ? c.getLockingScript() : null,
    ].filter(Boolean);

    const first = candidates[0];
    if (!first) {
      throw new Error(
        `Could not derive AuthGuard locking bytecode from artifact/contract. (No lockingBytecode/lockingScript/getLockingBytecode/getLockingScript on Contract instance)`
      );
    }

    // Normalize to hex string
    if (typeof first === 'string') {
      return first.trim().toLowerCase().replace(/^0x/i, '');
    }
    if (first instanceof Uint8Array) {
      return bytesToHex(first);
    }
    if (Array.isArray(first) && first.length && typeof first[0] === 'number') {
      return bytesToHex(Uint8Array.from(first));
    }
    if (first?.bytecode instanceof Uint8Array) {
      return bytesToHex(first.bytecode);
    }

    throw new Error(
      `Could not normalize AuthGuard locking bytecode. Got type=${typeof first} keys=${Object.keys(first ?? {})}`
    );
  }

  // ---------------------------------------------------------------------------
  // Step 0: Create Token (AuthKey + seed AuthHead reserves)
  // ---------------------------------------------------------------------------

  const createTokenStep0 = useCallback(async () => {
    setBusy(true);
    setBuildErr('');
    setBuildHex('');
    setBuildBytes(0);
    setStep0Status('');

    try {
      const addr = await getPrimaryWalletAddress();

      // Ensure fresh UTXOs
      const res0 = await sdk.utxos.listForWallet();
      const allUtxos0 = mergeWalletUtxos(res0);
      setWalletUtxos(allUtxos0);

      // 1) Find or create suitable genesis candidate (vout=0, non-token)
      let genesis = findSuitableGenesisCandidate(allUtxos0, addr);
      let tokenIdHex: string;

      if (!genesis) {
        const feeInput =
          feeUtxo ??
          allUtxos0.find(
            (u) => (u.value ?? 0) > MIN_GENESIS_SATS + 2000 && !u.token
          ) ??
          allUtxos0.find(
            (u) =>
              (u.value ?? 0) > MIN_GENESIS_SATS + 2000 &&
              !u.token &&
              u.address === addr
          ) ??
          null;

        if (!feeInput) {
          throw new Error(
            `No suitable BCH UTXO found to create genesis candidate. Need > ${
              MIN_GENESIS_SATS + 2000
            } sats.`
          );
        }

        setStep0Status('Creating vout=0 genesis candidate (tx1)…');

        const outputs1: TransactionOutput[] = [
          { recipientAddress: addr, amount: MIN_GENESIS_SATS },
        ];

        const built1 = await buildTx([feeInput], outputs1, addr);
        const txid1 = await broadcastTx(built1.hex);

        tokenIdHex = txid1;

        setStep0Status(`tx1 broadcasted: ${txid1}. Refreshing UTXOs…`);

        const res1 = await sdk.utxos.listForWallet();
        const after1 = mergeWalletUtxos(res1);
        setWalletUtxos(after1);

        genesis =
          after1.find(
            (u) => u.tx_hash === txid1 && u.tx_pos === 0 && !u.token
          ) ?? null;

        if (!genesis) {
          throw new Error(
            'tx1 broadcasted, but genesis UTXO not visible yet. Try “Load Wallet UTXOs” and run Step 0 again.'
          );
        }

        setGenesisUtxo(genesis);
      } else {
        tokenIdHex = genesis.tx_hash;
        setGenesisUtxo(genesis);
        setStep0Status(
          'Found suitable vout=0 genesis candidate. Skipping tx1.'
        );
      }

      // If AuthKey already exists for tokenId, skip tx2
      const haveKeyNow = findAuthKeyForTokenId(allUtxos0, tokenIdHex, addr);
      if (haveKeyNow) {
        setAuthKeyUtxo(haveKeyNow);
        setStep0Status('AuthKey already exists in wallet. Step 0 complete.');
        return;
      }

      // 2) tx2: mint AuthKey NFT + seed AuthGuard with FT reserve
      const reserve = toBigIntSafe(reserveSupply);
      if (reserve <= 0n)
        throw new Error('Reserve supply must be a positive integer.');

      const authGuardAddr = deriveAuthGuardAddress(tokenIdHex);

      setStep0Status('Minting AuthKey NFT + seeding AuthHead reserves (tx2)…');

      const outputs2: TransactionOutput[] = [
        // AuthKey NFT to primary address (capability none, amount 0)
        {
          recipientAddress: addr,
          amount: Math.max(Number(TOKEN_OUTPUT_SATS), Number(DUST)),
          token: {
            category: tokenIdHex,
            amount: 0n as any,
            nft: { capability: 'none', commitment: '' as any },
          },
        },

        // AuthHead reserve output to AuthGuard contract address
        {
          recipientAddress: authGuardAddr,
          amount: Math.max(Number(TOKEN_OUTPUT_SATS), Number(DUST)),
          token: { category: tokenIdHex, amount: reserve as any },
        },
      ];

      const built2 = await buildTx([genesis!], outputs2, addr);
      const txid2 = await broadcastTx(built2.hex);

      setStep0Status(`tx2 broadcasted: ${txid2}. Refreshing UTXOs…`);

      const res2 = await sdk.utxos.listForWallet();
      const after2 = mergeWalletUtxos(res2);
      setWalletUtxos(after2);

      const k2 = findAuthKeyForTokenId(after2, tokenIdHex, addr);
      if (k2) setAuthKeyUtxo(k2);

      // AuthHead lives at contract address, so discover via Chaingraph
      setAuthHeadUtxo(null);
      setAuthHeadCandidatesChain([]);

      setStep0Status(
        'Step 0 complete. AuthKey minted. Click “Load AuthHead (Chaingraph)” to discover AuthHead.'
      );
    } catch (e: any) {
      setBuildErr(e?.message ?? String(e));
      setStep0Status('');
    } finally {
      setBusy(false);
    }
  }, [sdk, loadWalletAddresses, feeUtxo, MIN_GENESIS_SATS, reserveSupply]);

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
          address: deriveAuthGuardAddress(tokenId), // contract address for display
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
        // Auto-select first if none selected
        if (!authHeadUtxo) setAuthHeadUtxo(deduped[0]);
      }
    } catch (e: any) {
      setAuthHeadStatus('');
      setBuildErr(e?.message ?? String(e));
    }
  }, [tokenId, authHeadUtxo]);

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
  // Build issuance/dispense tx
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
          'TokenId missing. Select a genesis UTXO (vout=0, non-token) or load an AuthHead from Chaingraph.'
        );
      }

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

      const sendAmt = toBigIntSafe(ftAmount);
      if (sendAmt <= 0n)
        throw new Error('FT amount must be a positive integer.');

      const headToken = head.token;
      if (!headToken?.category) {
        throw new Error('AuthHead UTXO has no token attached.');
      }

      const headCat = normalizeCategory(headToken.category);
      const expected = normalizeCategory(tokenId);
      if (headCat !== expected) {
        throw new Error(
          `AuthHead token category mismatch. expected=${tokenId} got=${String(
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

      const headContinuation: TransactionOutput = {
        recipientAddress: head.address, // keep same contract address (locking bytecode)
        amount: Math.max(Number(TOKEN_OUTPUT_SATS), Number(DUST)),
        ...(remaining > 0n
          ? { token: { category: tokenId, amount: remaining } }
          : {}),
      };
      outputs.push(headContinuation);

      outputs.push({
        recipientAddress: to,
        amount: Math.max(Number(TOKEN_OUTPUT_SATS), Number(DUST)),
        token: { category: tokenId, amount: sendAmt },
      });

      // Tag authHead as contract spend (your host builder will use ContractManager unlocker)
      const headInput: UTXO = {
        ...head,
        contractName: (head as any).contractName ?? 'authGuard',
        abi: (head as any).abi ?? (AUTHGUARD_ARTIFACT as any).abi,
        contractFunction: 'unlockWithNft',
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

  // Combined candidates: wallet-tagged (if ever present) + chaingraph results
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
    if (!tokenId)
      missing.push('TokenId (genesis UTXO vout=0) is not selected.');
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

        {/* STEP 0: Create Token */}
        <div className="border rounded p-3 mb-4 bg-gray-50">
          <div className="font-semibold mb-1">Step 0 — Create Token</div>
          <div className="text-xs text-gray-600 mb-3">
            Creates the required primitives with{' '}
            <span className="font-semibold">two transactions</span> but a single
            in-app action:
            <ul className="list-disc ml-5 mt-1">
              <li>
                If no suitable <span className="font-mono">vout=0</span> UTXO
                exists, tx1 creates one at your first wallet address.
              </li>
              <li>
                tx2 mints the <span className="font-semibold">AuthKey NFT</span>{' '}
                (capability <span className="font-mono">none</span>) and seeds
                the <span className="font-semibold">AuthHead</span> reserves at
                the AuthGuard contract address.
              </li>
              <li>
                AuthHead discovery should be done via Chaingraph (per your
                plan).
              </li>
            </ul>
          </div>

          <div className="grid gap-2">
            <label className="text-xs text-gray-600">
              Reserve supply to seed at AuthHead (FT amount)
              <input
                className="mt-1 w-full border rounded p-2 text-sm font-mono"
                value={reserveSupply}
                onChange={(e) => setReserveSupply(e.target.value)}
                placeholder="1000000"
              />
            </label>

            <div className="text-xs text-gray-600">
              Minimum recommended genesis sats:{' '}
              <span className="font-mono">{MIN_GENESIS_SATS}</span>
            </div>

            <button
              disabled={busy}
              onClick={createTokenStep0}
              className="bg-purple-700 hover:bg-purple-800 disabled:opacity-50 text-white py-2 px-3 rounded"
            >
              Create Token (AuthKey + Seed Reserves)
            </button>

            {step0Status && (
              <div className="text-xs text-gray-700">
                <span className="font-semibold">Status:</span> {step0Status}
              </div>
            )}

            {tokenId && (
              <div className="text-xs">
                <span className="font-semibold">tokenId:</span>{' '}
                <span className="font-mono">{tokenId}</span>
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
                      () => setGenesisUtxo(u),
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
            <div className="text-sm font-semibold">5) Dispense</div>

            <label className="text-xs text-gray-600">
              Recipient Address
              <input
                className="mt-1 w-full border rounded p-2 text-sm"
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
                placeholder="bitcoincash:..."
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

            {/* Missing-field warnings */}
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
              Build Issue / Dispense (FT)
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
            Patient-0: FT issuance build only. Next step is signing/broadcast UX
            + genesis/deploy.
          </div>
        </div>
      )}
    </div>
  );
}
