import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useSelector } from 'react-redux';
import { QRCodeSVG } from 'qrcode.react';
import { binToHex, hash256 } from '@bitauth/libauth';

import { selectWalletId } from '../../state/slices/walletSlice';
import MultisigPage from './MultisigPage';
import { QrScanDialog } from './QrScanDialog';
import {
  createMultisigDescriptorSet,
  type MultisigPolicy,
} from '../../services/psbt/multisigWallet';
import {
  cosignerStatuses,
  formatBip32Path,
  parseMultisigRedeemScript,
} from '../../services/psbt/psbtMultisig';
import { decodePsbt, type ParsedPsbt } from '../../services/psbt/psbtBch';
import {
  encodePsbtToQrDisplay,
  UrPsbtScanner,
  type UrFrames,
} from '../../services/psbt/urPsbt';
import {
  createMultisigSpendSession,
  listMultisigSpendSessions,
} from '../../services/multisig/MultisigSpendSessionService';
import { loadMultisigPolicy } from '../../services/multisig/MultisigStorageService';
import { signMultisigPsbtLocally } from '../../services/multisig/MultisigSignerService';
import { copyToClipboard } from '../../utils/clipboard';

type SignStage = 'receive' | 'review' | 'export';

const toBch = (satoshis: bigint): string =>
  (Number(satoshis) / 100_000_000).toFixed(8);

const equalBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

function validateIncomingPsbt(
  policy: MultisigPolicy,
  parsed: ParsedPsbt
): void {
  if (parsed.inputs.length === 0) throw new Error('The PSBT has no inputs.');
  if (parsed.outputs.length === 0) throw new Error('The PSBT has no outputs.');

  const fingerprints = new Map(
    policy.signers.map((signer) => [
      signer.masterFingerprintHex?.toLowerCase() ?? '',
      signer,
    ])
  );

  for (const [inputIndex, input] of parsed.inputs.entries()) {
    if (!input.spentLockingBytecode || input.spentSatoshis === null) {
      throw new Error(`Input ${inputIndex} is missing spent-output details.`);
    }
    if (input.token && !input.nonWitnessUtxo) {
      throw new Error(
        `Token input ${inputIndex} is missing its complete parent transaction.`
      );
    }
    if (!input.redeemScript) {
      throw new Error(`Input ${inputIndex} has no multisig redeem script.`);
    }
    const script = parseMultisigRedeemScript(input.redeemScript);
    if (
      !script ||
      script.requiredSignatures !== policy.threshold ||
      script.totalSignatures !== policy.signers.length
    ) {
      throw new Error(`Input ${inputIndex} does not match this multisig policy.`);
    }
    if (input.derivations.length !== script.keys.length) {
      throw new Error(
        `Input ${inputIndex} is missing one or more cosigner derivation records.`
      );
    }
    for (const derivation of input.derivations) {
      const fingerprint = binToHex(derivation.masterFingerprint).toLowerCase();
      const signer = fingerprints.get(fingerprint);
      if (!signer) {
        throw new Error(
          `Input ${inputIndex} contains a derivation for an unknown cosigner.`
        );
      }
      const path = formatBip32Path(derivation.derivationPath);
      if (!path.startsWith(`${signer.accountPath}/`)) {
        throw new Error(`Input ${inputIndex} has an invalid cosigner path.`);
      }
      if (!script.keys.some((key) => equalBytes(key, derivation.publicKey))) {
        throw new Error(`Input ${inputIndex} has a key outside its redeem script.`);
      }
    }
    for (const signature of input.partialSignatures) {
      if (!script.keys.some((key) => equalBytes(key, signature.publicKey))) {
        throw new Error(
          `Input ${inputIndex} contains a signature from a key outside the policy.`
        );
      }
    }
  }
}

export default function MultisigCosignerWorkspace() {
  const { wallet_id: routeWalletId } = useParams();
  const policyWalletId = Number(routeWalletId);
  const signerWalletId = useSelector(selectWalletId);

  const [policy, setPolicy] = useState<MultisigPolicy | null>(null);
  const [stage, setStage] = useState<SignStage>('receive');
  const [psbtBytes, setPsbtBytes] = useState<Uint8Array | null>(null);
  const [parsed, setParsed] = useState<ParsedPsbt | null>(null);
  const [sessionId, setSessionId] = useState('');
  const [unsignedTxHash, setUnsignedTxHash] = useState('');
  const [authorizationConfirmed, setAuthorizationConfirmed] = useState(false);
  const [importText, setImportText] = useState('');
  const [scannerOpen, setScannerOpen] = useState(false);
  const [scanProgress, setScanProgress] = useState(0);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [qrUri, setQrUri] = useState('');
  const [qrMode, setQrMode] = useState<'static' | 'stream'>('static');
  const [qrFrames, setQrFrames] = useState<UrFrames | null>(null);
  const [frameNumber, setFrameNumber] = useState(1);
  const scannerRef = useRef<UrPsbtScanner | null>(null);

  const policyId = useMemo(
    () =>
      policy
        ? createMultisigDescriptorSet(policy, policy.network).policyId
        : '',
    [policy]
  );

  const statuses = useMemo(
    () => (parsed ? cosignerStatuses(parsed) : []),
    [parsed]
  );
  const inputSatoshis = useMemo(
    () =>
      parsed?.inputs.reduce(
        (sum, input) => sum + (input.spentSatoshis ?? 0n),
        0n
      ) ?? 0n,
    [parsed]
  );
  const outputSatoshis = useMemo(
    () =>
      parsed?.outputs.reduce(
        (sum, output) => sum + (output.satoshis ?? 0n),
        0n
      ) ?? 0n,
    [parsed]
  );
  const feeSatoshis = inputSatoshis >= outputSatoshis
    ? inputSatoshis - outputSatoshis
    : null;

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setBusy(true);
      setError('');
      try {
        if (!Number.isSafeInteger(policyWalletId) || policyWalletId <= 0) {
          throw new Error('This multisig wallet route is invalid.');
        }
        const loaded = await loadMultisigPolicy(policyWalletId);
        if (!loaded) throw new Error('The multisig policy is not ready.');
        const loadedPolicyId = createMultisigDescriptorSet(
          loaded,
          loaded.network
        ).policyId;
        const sessions = await listMultisigSpendSessions(policyWalletId);
        const pending = sessions.find(
          (session) => session.policyId === loadedPolicyId
        );
        if (cancelled) return;
        setPolicy(loaded);
        if (pending) {
          const restored = decodePsbt(pending.psbtBytes);
          validateIncomingPsbt(loaded, restored);
          setPsbtBytes(pending.psbtBytes);
          setParsed(restored);
          setSessionId(pending.sessionId);
          setUnsignedTxHash(pending.unsignedTxHash);
          if (pending.stage === 'sign') {
            const display = encodePsbtToQrDisplay(pending.psbtBytes);
            setQrUri(display.uri);
            setQrMode(display.mode);
            setQrFrames(display.frames);
            setFrameNumber(1);
            setStage('export');
          } else {
            setStage('review');
          }
        }
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : 'Could not load the signer workspace.');
        }
      } finally {
        if (!cancelled) setBusy(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [policyWalletId]);

  useEffect(() => {
    if (!qrFrames) return;
    const timer = window.setInterval(() => {
      setQrUri(qrFrames.next());
      setFrameNumber((current) => (current >= qrFrames.count ? 1 : current + 1));
    }, 800);
    return () => window.clearInterval(timer);
  }, [qrFrames]);

  const acceptPsbt = async (bytes: Uint8Array) => {
    if (!policy) return;
    setBusy(true);
    setError('');
    try {
      const decoded = decodePsbt(bytes);
      validateIncomingPsbt(policy, decoded);
      const hash = binToHex(hash256(decoded.unsignedTransaction));
      const session = await createMultisigSpendSession({
        walletId: policyWalletId,
        policyId,
        unsignedTxHash: hash,
        psbtBytes: bytes,
      });
      setPsbtBytes(Uint8Array.from(bytes));
      setParsed(decoded);
      setSessionId(session.sessionId);
      setUnsignedTxHash(hash);
      setAuthorizationConfirmed(false);
      setStage('review');
      setImportText('');
      setScanProgress(1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not accept the PSBT.');
    } finally {
      setBusy(false);
    }
  };

  const handleFrame = (frame: string) => {
    try {
      if (!scannerRef.current) scannerRef.current = new UrPsbtScanner();
      const progress = scannerRef.current.receive(frame.trim());
      setScanProgress(progress.progress);
      if (progress.complete && progress.psbt) {
        scannerRef.current = null;
        setScannerOpen(false);
        void acceptPsbt(progress.psbt);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not read the QR frame.');
    }
  };

  const handlePaste = () => {
    setError('');
    const scanner = new UrPsbtScanner();
    try {
      for (const part of importText.split(/[\s,;]+/)) {
        if (!part.trim()) continue;
        const progress = scanner.receive(part.trim());
        setScanProgress(progress.progress);
        if (progress.complete && progress.psbt) {
          void acceptPsbt(progress.psbt);
          return;
        }
      }
      setError('Not enough UR frames. Paste every frame, one per line.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not read the pasted PSBT.');
    }
  };

  const sign = async () => {
    if (!psbtBytes || !parsed || !policy || !sessionId) return;
    if (!signerWalletId || signerWalletId === policyWalletId) {
      setError('Open this policy alongside the standard mnemonic wallet on this device.');
      return;
    }
    if (!authorizationConfirmed) {
      setError('Review the transaction and confirm before signing.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const result = await signMultisigPsbtLocally({
        policyWalletId,
        signerWalletId,
        sessionId,
        policyId,
        unsignedTxHash,
        psbtBytes,
        authorize: async () => undefined,
      });
      if (result.signedInputIndexes.length === 0) {
        throw new Error('This device is not a remaining signer for any input.');
      }
      const display = encodePsbtToQrDisplay(result.psbtBytes);
      setPsbtBytes(result.psbtBytes);
      setParsed(decodePsbt(result.psbtBytes));
      setQrUri(display.uri);
      setQrMode(display.mode);
      setQrFrames(display.frames);
      setFrameNumber(1);
      setCopied(false);
      setStage('export');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not sign the PSBT.');
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    scannerRef.current = null;
    setStage('receive');
    setPsbtBytes(null);
    setParsed(null);
    setSessionId('');
    setUnsignedTxHash('');
    setAuthorizationConfirmed(false);
    setImportText('');
    setQrUri('');
    setQrFrames(null);
    setCopied(false);
    setError('');
  };

  return (
    <MultisigPage>
      <section className="wallet-card space-y-3 p-4">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--wallet-accent-strong)]">
          Cosigner signing
        </p>
        <h1 className="text-xl font-bold wallet-text-strong">
          Sign a multisig proposal
        </h1>
        <p className="text-sm leading-relaxed wallet-muted">
          Receive a PSBT from the coordinator, review the exact spend, sign only
          with this device&apos;s matching cosigner key, then return the signed
          PSBT. This screen never broadcasts.
        </p>
        {policy && (
          <p className="break-all rounded-xl border border-[var(--wallet-border)] p-3 font-mono text-[10px] wallet-muted">
            Policy ID: {policyId}
          </p>
        )}
      </section>

      {busy && !policy && <p className="text-sm wallet-muted">Loading policy…</p>}

      {stage === 'receive' && (
        <section className="wallet-card space-y-3 p-4">
          <h2 className="font-semibold wallet-text-strong">Receive proposal</h2>
          <p className="text-xs wallet-muted">
            Scan the coordinator&apos;s QR. For an animated UR, scan every frame;
            duplicates and out-of-order frames are safe.
          </p>
          <button
            type="button"
            className="wallet-btn-primary w-full py-2 font-semibold"
            onClick={() => {
              scannerRef.current = new UrPsbtScanner();
              setScanProgress(0);
              setScannerOpen(true);
            }}
            disabled={!policy || busy}
          >
            Scan proposal QR
          </button>
          <details>
            <summary className="cursor-pointer text-xs wallet-muted">
              Or paste UR text
            </summary>
            <textarea
              value={importText}
              onChange={(event) => setImportText(event.target.value)}
              rows={5}
              spellCheck={false}
              placeholder="ur:crypto-psbt/... one frame per line"
              className="wallet-input mt-2 w-full resize-y font-mono text-[10px]"
            />
            <button
              type="button"
              className="wallet-btn-secondary mt-2 w-full py-2 text-xs"
              onClick={handlePaste}
              disabled={!importText.trim() || busy}
            >
              Import proposal
            </button>
          </details>
          {scanProgress > 0 && scanProgress < 1 && (
            <p className="text-xs wallet-muted">
              QR progress: {Math.round(scanProgress * 100)}%
            </p>
          )}
        </section>
      )}

      {stage !== 'receive' && parsed && policy && (
        <>
          <section className="wallet-card space-y-3 p-4">
            <div className="flex items-center justify-between gap-3">
              <h2 className="font-semibold wallet-text-strong">Review spend</h2>
              <span className="rounded-full border border-[var(--wallet-border)] px-2 py-1 text-[10px] uppercase wallet-muted">
                {parsed.inputs.some((input) => input.token) ? 'CashTokens' : 'BCH'}
              </span>
            </div>
            <div className="grid gap-2 text-xs wallet-muted sm:grid-cols-2">
              <p>Inputs: {parsed.inputs.length} · outputs: {parsed.outputs.length}</p>
              <p>Required: {policy.threshold} of {policy.signers.length}</p>
              <p>Input value: {toBch(inputSatoshis)} BCH</p>
              <p>Output value: {toBch(outputSatoshis)} BCH</p>
              <p>Fee: {feeSatoshis === null ? 'invalid' : `${toBch(feeSatoshis)} BCH`}</p>
              <p className="break-all font-mono">TX: {unsignedTxHash}</p>
            </div>
            <div className="space-y-1 rounded-xl border border-[var(--wallet-border)] p-3">
              <p className="text-xs font-semibold wallet-text-strong">Cosigner progress</p>
              {statuses.map((inputStatuses, index) => {
                const signed = inputStatuses.filter((status) => status.signed).length;
                return (
                  <p key={index} className="text-[11px] wallet-muted">
                    Input {index}: {signed} of {policy.threshold} signatures
                    {inputStatuses.map((status) => (
                      <span key={status.publicKeyHex} className="ml-2 font-mono">
                        {status.signed ? '✓' : '○'}{status.fingerprintHex.toUpperCase()}
                      </span>
                    ))}
                  </p>
                );
              })}
            </div>
            {stage === 'review' && (
              <>
                <label className="flex items-start gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-xs wallet-muted">
                  <input
                    type="checkbox"
                    checked={authorizationConfirmed}
                    onChange={(event) => setAuthorizationConfirmed(event.target.checked)}
                    className="mt-0.5 accent-[var(--wallet-accent)]"
                  />
                  <span>
                    I reviewed the policy, inputs, destination, BCH value, fee,
                    change, and token state. Authorize this device to sign.
                  </span>
                </label>
                <button
                  type="button"
                  className="wallet-btn-primary w-full py-2 font-semibold disabled:opacity-50"
                  onClick={() => void sign()}
                  disabled={!authorizationConfirmed || busy}
                >
                  {busy ? 'Signing…' : 'Authorize and sign with this device'}
                </button>
              </>
            )}
          </section>

          {stage === 'export' && qrUri && (
            <section className="wallet-card space-y-3 p-4">
              <h2 className="font-semibold wallet-text-strong">
                Return signed proposal to coordinator
              </h2>
              <div className="flex justify-center rounded-md bg-white p-3">
                <QRCodeSVG value={qrUri} size={220} includeMargin />
              </div>
              <p className="text-center text-xs wallet-muted">
                {qrMode === 'stream'
                  ? `Frame ${frameNumber} / ${qrFrames?.count ?? 0} · scan the looping frames`
                  : 'Static signed PSBT QR'}
              </p>
              <button
                type="button"
                className="wallet-btn-secondary w-full py-2 text-sm"
                onClick={() => void copyToClipboard(qrUri).then(setCopied)}
              >
                {copied ? 'Copied signed UR text' : 'Copy signed UR text'}
              </button>
              <textarea
                readOnly
                value={qrUri}
                rows={4}
                className="wallet-input w-full resize-y font-mono text-[10px]"
                aria-label="Signed PSBT UR text"
              />
              <p className="text-xs wallet-muted">
                The coordinator must import this signed PSBT and verify it
                before asking another cosigner or broadcasting.
              </p>
            </section>
          )}
        </>
      )}

      {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
      {(stage === 'review' || stage === 'export') && (
        <button
          type="button"
          className="wallet-btn-secondary w-full py-2 text-sm"
          onClick={reset}
          disabled={busy}
        >
          Sign another proposal
        </button>
      )}

      {scannerOpen && (
        <QrScanDialog
          onFrame={handleFrame}
          onClose={() => setScannerOpen(false)}
        />
      )}
    </MultisigPage>
  );
}
