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
//
// That window is also pinned to the unlock session it was granted under (see
// WalletKeyCache's unlock epoch). Locking the wallet, or switching to another
// one, voids it immediately — otherwise a re-locked wallet could keep spending
// on authorisation the user gave before the lock.

import { store } from '../../state/store';
import { selectAutoLockMinutes } from '../../state/slices/appLockSlice';
import { getUnlockEpoch } from './WalletKeyCache';

export const INTEGRITY_EVENT = 'optn:integrity-check';

const REVEAL_SCOPES = new Set<string>([
  'recovery_phrase_reveal',
  'private_key_reveal',
]);
const SPEND_SCOPES = new Set<string>(['fetchAddressPrivateKey_spend']);

const SPEND_AUTH_TTL_MS = 600_000;

// If nothing answers the prompt, fail rather than hang. A signing call that
// waits forever looks identical to a wedged wallet, and the caller can neither
// retry nor report it. Generous enough for someone to find their password.
const PROMPT_TIMEOUT_MS = 120_000;

type PendingPrompt = {
  resolve: () => void;
  reject: (err: Error) => void;
  scope: string | null;
  timer: ReturnType<typeof setTimeout>;
};

let _pending: PendingPrompt | null = null;
let _lastSpendAuthAt = 0;
// The unlock session the last spend auth was granted under. A bare timestamp
// survives a lock/unlock cycle, which would let a re-locked wallet spend on
// authorisation the user gave to the previous session.
let _lastSpendAuthEpoch = -1;

/** Settle and clear the in-flight prompt, if any. */
function settlePending(err: Error | null): PendingPrompt | null {
  const pending = _pending;
  if (!pending) return null;
  clearTimeout(pending.timer);
  _pending = null;
  if (err) pending.reject(err);
  else pending.resolve();
  return pending;
}

export function resolveIntegrityCheck(): void {
  const pending = settlePending(null);
  if (pending?.scope && SPEND_SCOPES.has(pending.scope)) {
    _lastSpendAuthAt = Date.now();
    _lastSpendAuthEpoch = getUnlockEpoch();
  }
}

export function rejectIntegrityCheck(reason = 'Passphrase verification failed'): void {
  settlePending(new Error(reason));
}

export function clearSpendAuthCache(): void {
  _lastSpendAuthAt = 0;
  _lastSpendAuthEpoch = -1;
}

/**
 * Call right after a successful wallet unlock (password verified at open).
 * Starts the 10-minute Never-mode spend window so the first Send does not
 * re-prompt immediately after login — the open password already proved it.
 * Timer auto-lock modes ignore this (they never re-prompt on spend).
 */
export function markSpendAuthFromUnlock(): void {
  _lastSpendAuthAt = Date.now();
  _lastSpendAuthEpoch = getUnlockEpoch();
}

/** True if a previous spend auth is still good for the current unlock session. */
function spendAuthStillValid(): boolean {
  if (_lastSpendAuthEpoch !== getUnlockEpoch()) return false;
  return Date.now() - _lastSpendAuthAt < SPEND_AUTH_TTL_MS;
}

async function assertDeviceIntegrity(scope: string): Promise<void> {
  if (REVEAL_SCOPES.has(scope)) {
    return promptPassphrase();
  }

  if (SPEND_SCOPES.has(scope)) {
    const autoLock = selectAutoLockMinutes(store.getState());
    if (autoLock !== 0) return;
    if (spendAuthStillValid()) return;
    return promptPassphrase(scope);
  }
}

async function promptPassphrase(scope?: string): Promise<void> {
  // A second prompt must not orphan the first: the old caller would await a
  // promise nobody can settle any more.
  settlePending(new Error('Superseded by a newer verification request'));

  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      _pending = null;
      reject(new Error('Password confirmation timed out'));
    }, PROMPT_TIMEOUT_MS);

    _pending = { resolve, reject, scope: scope ?? null, timer };
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
