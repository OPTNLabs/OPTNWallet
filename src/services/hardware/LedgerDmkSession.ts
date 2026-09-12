/**
 * Ledger connection on the Device Management Kit.
 *
 * DMK replaces the LedgerJS family Ledger deprecated in September 2026. What
 * it gives us is the half worth taking from a vendor: discovery, connection,
 * device sessions, and a transport per platform — WebHID and WebBLE in a
 * browser or extension, and more as they land. That is the part that used to
 * be `@ledgerhq/hw-transport-*`, and it is now maintained in one place.
 *
 * What it does not give us is a Bitcoin Cash signer. There are twelve signer
 * kits and none of them is BCH; the Bitcoin one speaks the wallet-policy
 * protocol our chain's device app does not. So the app-binder is ours, in
 * `ledgerBchApdu.ts`, sitting on `dmk.sendApdu` — the same shape Ledger's own
 * signer kits have.
 *
 * Everything here is behind a dynamic import. DMK is only reachable where a
 * DMK transport exists, and a desktop WebView with no WebHID must not pay to
 * load it.
 */

import {
  buildGetWalletPublicKey,
  describeStatusWord,
  parseWalletPublicKey,
  type AddressFormat,
  type Apdu,
  type WalletPublicKey,
} from './ledgerBchApdu';

/** Which DMK transport this runtime can offer, or none. */
export type DmkTransportKind = 'web-hid' | 'web-ble';

export interface DmkAvailability {
  /** Transports the runtime actually exposes, in preference order. */
  readonly transports: DmkTransportKind[];
  /** Why DMK cannot be used here, or null when it can. */
  readonly unavailableReason: string | null;
}

/**
 * What this runtime can do, asked of the runtime rather than assumed from the
 * platform.
 *
 * A desktop Tauri WebView has neither `navigator.hid` nor `navigator.bluetooth`
 * and reaches a Ledger through Rust instead, so it correctly reports none.
 */
export function dmkAvailability(
  nav: Navigator | undefined = typeof navigator === 'undefined'
    ? undefined
    : navigator
): DmkAvailability {
  const runtime = nav as
    | (Navigator & { hid?: unknown; bluetooth?: unknown })
    | undefined;

  const transports: DmkTransportKind[] = [];
  if (runtime && typeof runtime.hid === 'object' && runtime.hid !== null) {
    transports.push('web-hid');
  }
  if (
    runtime &&
    typeof runtime.bluetooth === 'object' &&
    runtime.bluetooth !== null
  ) {
    transports.push('web-ble');
  }

  return {
    transports,
    unavailableReason: transports.length
      ? null
      : 'This build has neither WebHID nor Web Bluetooth, so the Device ' +
        'Management Kit cannot reach a device here. The desktop app talks to ' +
        'a Ledger over USB from Rust instead.',
  };
}

/** The subset of DMK this module uses, so the import can stay dynamic. */
interface DmkLike {
  sendApdu(args: {
    sessionId: string;
    apdu: Uint8Array;
  }): Promise<{ data: Uint8Array; statusCode: Uint8Array }>;
  close?(): Promise<void>;
}

interface ActiveSession {
  dmk: DmkLike;
  sessionId: string;
}

let active: ActiveSession | null = null;

/**
 * Serialise an APDU: class, instruction, both parameters, a one-byte length,
 * then the body.
 */
export function encodeApdu(apdu: Apdu): Uint8Array {
  if (apdu.data.length > 255) {
    throw new Error(
      `an APDU body is at most 255 bytes, got ${apdu.data.length}`
    );
  }
  const out = new Uint8Array(5 + apdu.data.length);
  out[0] = apdu.cla;
  out[1] = apdu.ins;
  out[2] = apdu.p1;
  out[3] = apdu.p2;
  out[4] = apdu.data.length;
  out.set(apdu.data, 5);
  return out;
}

/** Read the two-byte status word DMK returns beside the payload. */
export function statusOf(statusCode: Uint8Array): number {
  if (statusCode.length < 2) {
    throw new Error('the device returned no status word');
  }
  return (statusCode[0] << 8) | statusCode[1];
}

/**
 * Ask the connected device for the public key and cashaddr at a path.
 *
 * Throws with the device's own reason when it refuses — a locked Ledger and
 * the wrong app open are different problems with different fixes, and telling
 * someone "failed" sends them to check the cable.
 */
export async function dmkGetWalletPublicKey(
  path: string,
  options: { verify?: boolean; format?: AddressFormat } = {}
): Promise<WalletPublicKey> {
  const session = active;
  if (!session) {
    throw new Error(
      'No Ledger session is open. Connect the device before asking it for an account.'
    );
  }

  const response = await session.dmk.sendApdu({
    sessionId: session.sessionId,
    apdu: encodeApdu(buildGetWalletPublicKey(path, options)),
  });

  const status = statusOf(response.statusCode);
  const problem = describeStatusWord(status);
  if (problem) {
    throw new Error(problem);
  }
  return parseWalletPublicKey(response.data);
}

/** Hand this module a live session. Used by the connect flow and by tests. */
export function setActiveSession(dmk: DmkLike, sessionId: string): void {
  active = { dmk, sessionId };
}

export function clearActiveSession(): void {
  active = null;
}

export function hasActiveSession(): boolean {
  return active !== null;
}
