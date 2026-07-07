// BCH RPA Sender — signature grinding for sending to a paycode.
//
// Status: stub. Signature grinding is too CPU-intensive for the main thread.
// The algorithm works by:
//   1. Build the transaction normally with a dummy destination.
//   2. Compute the real destination via ECDH(sender_privkey, recipient_scan_pubkey).
//   3. Replace the dummy output with the real one-time address.
//   4. Sign the transaction inputs with nonce k=1, k=2, … until:
//        SHA256(SHA256(serialized_input))[:N_bits] === recipient.scanPubkey[:N_bits]
//   5. Broadcast that transaction — no separate notification tx needed.
//
// Reference: Electron Cash electroncash/rpa/addr.py + paycode.py
//
// The grinding loop is tightly bound (thousands of iterations per second) and
// must run in a Tauri sidecar, Rust command, or WebWorker to avoid freezing the UI.

export type RpaSendResult =
  | { ok: true; txHex: string }
  | { ok: false; error: string };

export async function sendToPaycode(
  _paycodeStr: string,
  _satoshis: number,
  _walletId: number,
): Promise<RpaSendResult> {
  return {
    ok: false,
    error:
      'Sending to a paycode requires signature grinding, which runs in a background worker. ' +
      'This feature is not yet implemented — check back in a future release.',
  };
}
