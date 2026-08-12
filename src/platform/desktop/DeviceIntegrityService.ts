// Desktop shim for src/services/DeviceIntegrityService.ts
//
// EC model: a wallet is opened with its own password, whose derived key stays
// in RAM for the session. Routine operations that use that key (deriving a
// receive address, signing) must NOT re-prompt — the wallet is already
// unlocked, so re-entering the password adds no security, only friction (this
// was why "Receive" kept asking for a password).
//
// The password is re-confirmed ONLY for scopes that EXPORT the secret itself
// to the screen — i.e. revealing the recovery phrase. AppLockGate listens for
// INTEGRITY_EVENT, renders the modal, and calls resolveIntegrityCheck /
// rejectIntegrityCheck.

export const INTEGRITY_EVENT = 'optn:integrity-check';

// Scopes that reveal the raw secret to the user and therefore re-confirm the
// wallet password. Everything else (fetchAddressPrivateKey, signMessageForAddress,
// …) is a routine op on the already-open wallet and passes without a prompt.
const REVEAL_SCOPES = new Set<string>(['recovery_phrase_reveal']);

let _resolve: (() => void) | null = null;
let _reject: ((err: Error) => void) | null = null;

/** Called by the passphrase confirmation modal on success. */
export function resolveIntegrityCheck(): void {
  _resolve?.();
  _resolve = _reject = null;
}

/** Called by the passphrase confirmation modal on cancel or wrong passphrase. */
export function rejectIntegrityCheck(reason = 'Passphrase verification failed'): void {
  _reject?.(new Error(reason));
  _resolve = _reject = null;
}

async function assertDeviceIntegrity(scope: string): Promise<void> {
  // Routine operations on the already-open wallet pass silently.
  if (!REVEAL_SCOPES.has(scope)) return;
  return new Promise<void>((resolve, reject) => {
    _resolve = resolve;
    _reject = reject;
    window.dispatchEvent(new CustomEvent(INTEGRITY_EVENT, { detail: { scope } }));
  });
}

async function assessInternal(): Promise<{ compromised: false; reasons: [] }> {
  return { compromised: false, reasons: [] };
}

const DeviceIntegrityService = {
  assertDeviceIntegrity,
  assessInternal,
};

export default DeviceIntegrityService;
