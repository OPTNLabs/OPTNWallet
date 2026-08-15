// Session-only gate for automatic Fusion continuation.
//
// The persisted `autoFuseEnabled` setting is a preference, not permission to
// spend. A wallet must first receive an explicit manual Fusion start in the
// current app session before the background engine may schedule another round.
// Keeping this gate in memory means restoring a wallet or reopening the app
// never arms a fee-spending loop by itself.

type Listener = () => void;

let armedWalletId: number | null = null;
const listeners = new Set<Listener>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function isAutoFusionSessionArmed(walletId: number): boolean {
  return (
    Number.isSafeInteger(walletId) && walletId > 0 && armedWalletId === walletId
  );
}

/** Arm only after the user has explicitly started a Fusion round. */
export function armAutoFusionSession(walletId: number): void {
  if (!Number.isSafeInteger(walletId) || walletId <= 0) return;
  if (armedWalletId === walletId) return;
  armedWalletId = walletId;
  notify();
}

export function disarmAutoFusionSession(walletId?: number): void {
  if (walletId !== undefined && armedWalletId !== walletId) return;
  if (armedWalletId === null) return;
  armedWalletId = null;
  notify();
}

export function subscribeAutoFusionSession(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
