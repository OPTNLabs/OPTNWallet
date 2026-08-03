// Desktop shim for src/services/DeviceIntegrityService.ts
//
// Security model (EC-compatible):
// - Read-only ops (address derivation, balance): no prompt
// - Spending ops (signing a send tx): re-prompt password ONLY when auto-lock is
//   "Never" (0) — otherwise the inactivity timer handles session protection
// - Secret reveal (recovery phrase): always re-prompt password
// - Auto-fusion: no prompt (password cached in session, user consented)
//
// After a successful spend auth, subsequent spend ops are cached for 10 min so
// rapid multi-input or batched signing doesn't re-prompt on each call. The
// timer resets on each successful auth — if the user is actively spending, the
// window stays open. Once it expires, the next spend re-prompts for the wallet
// password.

import { store } from '../../state/store';
import { selectAutoLockMinutes } from '../../state/slices/appLockSlice';

export const INTEGRITY_EVENT = 'optn:integrity-check';

const REVEAL_SCOPES = new Set<string>(['recovery_phrase_reveal']);
const SPEND_SCOPES = new Set<string>(['fetchAddressPrivateKey_spend']);

const SPEND_AUTH_TTL_MS = 600_000;

let _resolve: (() => void) | null = null;
let _reject: ((err: Error) => void) | null = null;
let _lastSpendAuthAt = 0;
let _pendingScope: string | null = null;

export function resolveIntegrityCheck(): void {
  _resolve?.();
  _resolve = _reject = null;
  if (_pendingScope && SPEND_SCOPES.has(_pendingScope)) {
    _lastSpendAuthAt = Date.now();
  }
  _pendingScope = null;
}

export function rejectIntegrityCheck(reason = 'Passphrase verification failed'): void {
  _reject?.(new Error(reason));
  _resolve = _reject = null;
  _pendingScope = null;
}

export function clearSpendAuthCache(): void {
  _lastSpendAuthAt = 0;
}

async function assertDeviceIntegrity(scope: string): Promise<void> {
  if (REVEAL_SCOPES.has(scope)) {
    return promptPassphrase();
  }

  if (SPEND_SCOPES.has(scope)) {
    const autoLock = selectAutoLockMinutes(store.getState());
    if (autoLock !== 0) return;
    if (Date.now() - _lastSpendAuthAt < SPEND_AUTH_TTL_MS) return;
    return promptPassphrase(scope);
  }
}

async function promptPassphrase(scope?: string): Promise<void> {
  _pendingScope = scope ?? null;
  return new Promise<void>((resolve, reject) => {
    _resolve = resolve;
    _reject = reject;
    window.dispatchEvent(
      new CustomEvent(INTEGRITY_EVENT, { detail: { scope: scope ?? 'integrity' } })
    );
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
