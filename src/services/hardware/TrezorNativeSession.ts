/**
 * Trezor session — Electron Cash / trezorlib transport order:
 *   HID (Model One) → WebUSB/libusb (Safe 5 / Model T) → Bridge (:21325, optional)
 *
 * Wire protocol = @trezor/protobuf + @trezor/protocol (same as Suite / EC).
 * Native process only — never WebView WebUSB/WebHID.
 *
 * Modern Suite no longer always starts Bridge; Safe 5 is WebUSB (VID 1209/PID 53c1).
 */

import { Buffer } from 'buffer';
import {
  decodeMessage,
  encodeMessage,
  parseConfigure,
} from '@trezor/protobuf';
import messagesJson from '@trezor/protobuf/messages.json';
import { v1 as protocolV1 } from '@trezor/protocol';
import {
  bridgeCall,
  bridgeEnumerate,
  bridgePing,
  type BridgeDevice,
} from './trezorBridge';
import {
  canUseNativeHw,
  findFirstDevice,
  hwClose,
  hwOpen,
  hwRead,
  hwWrite,
  trezorWebUsbClose,
  trezorWebUsbEnumerate,
  trezorWebUsbOpen,
  trezorWebUsbRead,
  trezorWebUsbWrite,
  type HwFamily,
} from './nativeHw';

type ProtobufRoot = ReturnType<typeof parseConfigure>;
let messagesRoot: ProtobufRoot | null = null;

function messages(): ProtobufRoot {
  if (!messagesRoot) messagesRoot = parseConfigure(messagesJson);
  return messagesRoot;
}

const HID_CHUNK = 64;
const HEADER_SIZE = 9;

function stripReportId(buf: Buffer): Buffer {
  if (buf.length === 65 && buf[0] === 0x00) return buf.subarray(1);
  return buf.length > 64 ? buf.subarray(0, 64) : buf;
}

export type NativeHwCallResult = {
  type: string;
  message: Record<string, unknown>;
};

type WireMode =
  | { kind: 'bridge'; path: string; session: string }
  | { kind: 'webusb'; sessionId: number }
  | { kind: 'hid'; sessionId: number };

export class TrezorNativeSession {
  private wire: WireMode | null = null;
  private readonly family: HwFamily;

  constructor(family: HwFamily = 'trezor') {
    this.family = family;
  }

  static async bridgeAvailable(): Promise<boolean> {
    return (await bridgePing()) != null;
  }

  /**
   * EC trezorlib order: HID → WebUSB → Bridge.
   * Safe 5 = WebUSB (libusb). Model One = HID. Bridge optional if Suite runs trezord.
   */
  async open(): Promise<{ via: 'bridge' | 'webusb' | 'hid'; label: string }> {
    if (!canUseNativeHw()) {
      throw new Error('Native USB only available in the desktop app.');
    }

    // 1) Classic HID — Trezor One / some OneKey
    if (this.family === 'onekey' || this.family === 'trezor') {
      const hidDev = await findFirstDevice(
        this.family === 'onekey' ? 'onekey' : 'trezor'
      );
      if (hidDev) {
        const sessionId = await hwOpen(hidDev.path, this.family);
        this.wire = { kind: 'hid', sessionId };
        return { via: 'hid', label: hidDev.product ?? 'Trezor One (HID)' };
      }
    }

    // 2) WebUSB / libusb — Safe 5, Model T (trezorlib WebUsbTransport)
    try {
      const web = await trezorWebUsbEnumerate();
      if (web.length > 0) {
        const sessionId = await trezorWebUsbOpen(web[0].path);
        this.wire = { kind: 'webusb', sessionId };
        return {
          via: 'webusb',
          label:
            web[0].product ??
            `Trezor WebUSB ${web[0].vendor_id.toString(16)}:${web[0].product_id.toString(16)}`,
        };
      }
    } catch (err) {
      // Fall through to Bridge; surface last error if all fail
      console.warn('[TrezorNativeSession] WebUSB enumerate/open:', err);
    }

    // 3) Bridge (optional — Suite may start trezord; not required for Safe 5)
    const bridge = await bridgePing();
    if (bridge) {
      const devices = await bridgeEnumerate();
      if (devices.length > 0) {
        const dev =
          devices.find((d) => !d.debug) ?? (devices[0] as BridgeDevice);
        const { bridgeAcquire } = await import('./trezorBridge');
        const sessionId = await bridgeAcquire(dev.path);
        this.wire = { kind: 'bridge', path: dev.path, session: sessionId };
        return { via: 'bridge', label: `Bridge ${bridge.version}` };
      }
    }

    throw new Error(
      'No Trezor found.\n' +
        '• Safe 5 / Model T: unlock PIN, close Suite if open, data USB cable (WebUSB/libusb)\n' +
        '• Model One: plug USB HID\n' +
        '• Optional: Suite Bridge on :21325 if WebUSB drivers fail'
    );
  }

  async close(): Promise<void> {
    if (!this.wire) return;
    if (this.wire.kind === 'bridge') {
      const { bridgeRelease } = await import('./trezorBridge');
      await bridgeRelease(this.wire.session);
    } else if (this.wire.kind === 'webusb') {
      await trezorWebUsbClose(this.wire.sessionId);
    } else {
      await hwClose(this.wire.sessionId);
    }
    this.wire = null;
  }

  private async writeRaw(encoded: Buffer): Promise<void> {
    if (!this.wire) throw new Error('Trezor session not open');
    if (this.wire.kind === 'bridge') {
      await bridgeCall(this.wire.session, encoded.toString('hex'));
      return;
    }
    // trezorlib HID/WebUSB write_chunk: every 64-byte report is
    //   0x3f || up to 63 bytes of protocol payload (padded with zeros).
    // Sending raw 64-byte slices of the encoded message drops the segment
    // marker and misframes multi-packet SignTx.
    let offset = 0;
    while (offset < encoded.length) {
      const chunk = Buffer.alloc(HID_CHUNK);
      chunk[0] = 0x3f;
      const n = Math.min(HID_CHUNK - 1, encoded.length - offset);
      encoded.copy(chunk, 1, offset, offset + n);
      offset += n;
      const hex = chunk.toString('hex');
      if (this.wire.kind === 'webusb') {
        await trezorWebUsbWrite(this.wire.sessionId, hex);
      } else {
        await hwWrite(this.wire.sessionId, hex);
      }
    }
  }

  private async readRaw(timeoutMs: number): Promise<Buffer> {
    if (!this.wire) throw new Error('Trezor session not open');
    if (this.wire.kind === 'bridge') {
      throw new Error(
        'Internal: bridge read must use response from bridgeCall write path'
      );
    }
    // Narrow once so nested callbacks keep sessionId (not bridge.session).
    const usbWire = this.wire;
    const readUsbChunk = async (): Promise<string> =>
      usbWire.kind === 'webusb'
        ? trezorWebUsbRead(usbWire.sessionId, timeoutMs)
        : hwRead(usbWire.sessionId, timeoutMs);

    /** Strip USB report id (0x00) and HID/WebUSB 0x3f segment marker. */
    const unwrapReport = (raw: Buffer): Buffer => {
      let buf = stripReportId(raw);
      if (buf.length > 0 && buf[0] === 0x3f) {
        buf = buf.subarray(1);
      }
      return buf;
    };

    const first = unwrapReport(Buffer.from(await readUsbChunk(), 'hex'));
    // Protocol v1 header after unwrap: ## | type(2) | length(4) | payload
    if (first.length < HEADER_SIZE) {
      throw new Error('Trezor USB: short first packet');
    }
    const payloadLen = first.readUInt32BE(5);
    const total = HEADER_SIZE + payloadLen;
    let assembled = Buffer.from(first);
    while (assembled.length < total) {
      const next = unwrapReport(Buffer.from(await readUsbChunk(), 'hex'));
      assembled = Buffer.concat([assembled, next]);
    }
    return assembled.subarray(0, total);
  }

  /**
   * Request/response with ButtonRequest auto-ack (EC/Suite behaviour).
   */
  async call(
    name: string,
    data: Record<string, unknown> = {},
    opts?: { timeoutMs?: number }
  ): Promise<NativeHwCallResult> {
    if (!this.wire) throw new Error('Trezor session not open');
    const timeoutMs = opts?.timeoutMs ?? 120_000;
    const { messageType, message } = encodeMessage(messages(), name, data);
    const encoded = Buffer.from(
      protocolV1.encode(Buffer.from(message), { messageType })
    );

    if (this.wire.kind === 'bridge') {
      // One Bridge /call = one message exchange (trezorlib Bridge transport).
      let responseHex = await bridgeCall(
        this.wire.session,
        encoded.toString('hex')
      );
      for (let round = 0; round < 32; round++) {
        const buf = Buffer.from(responseHex.replace(/\s/g, ''), 'hex');
        const decodedFrame = protocolV1.decode(buf);
        const msg = decodeMessage(
          messages(),
          decodedFrame.messageType,
          Buffer.from(decodedFrame.payload.subarray(0, decodedFrame.length))
        );
        const type = String(msg.type);
        const messageObj = (msg.message ?? {}) as Record<string, unknown>;

        if (type === 'ButtonRequest') {
          const ack = encodeMessage(messages(), 'ButtonAck', {});
          const ackEnc = Buffer.from(
            protocolV1.encode(Buffer.from(ack.message), {
              messageType: ack.messageType,
            })
          );
          responseHex = await bridgeCall(
            this.wire.session,
            ackEnc.toString('hex')
          );
          continue;
        }
        if (type === 'PinMatrixRequest') {
          throw new Error(
            'Enter PIN on the device (not on the computer), unlock, then retry.'
          );
        }
        if (type === 'PassphraseRequest') {
          throw new Error(
            'Enter passphrase on the device, then retry.'
          );
        }
        if (type === 'Failure') {
          throw new Error(
            `Device failure: ${String(messageObj.message ?? messageObj.code ?? 'unknown')}`
          );
        }
        return { type, message: messageObj };
      }
      throw new Error('Trezor: too many interactive rounds');
    }

    // HID path
    await this.writeRaw(encoded);
    for (let round = 0; round < 32; round++) {
      const assembled = await this.readRaw(timeoutMs);
      const decodedFrame = protocolV1.decode(assembled);
      const msg = decodeMessage(
        messages(),
        decodedFrame.messageType,
        Buffer.from(decodedFrame.payload.subarray(0, decodedFrame.length))
      );
      const type = String(msg.type);
      const messageObj = (msg.message ?? {}) as Record<string, unknown>;
      if (type === 'ButtonRequest') {
        const ack = encodeMessage(messages(), 'ButtonAck', {});
        await this.writeRaw(
          Buffer.from(
            protocolV1.encode(Buffer.from(ack.message), {
              messageType: ack.messageType,
            })
          )
        );
        continue;
      }
      if (type === 'Failure') {
        throw new Error(
          `Device failure: ${String(messageObj.message ?? 'unknown')}`
        );
      }
      if (type === 'PinMatrixRequest' || type === 'PassphraseRequest') {
        throw new Error(`Device requires ${type} — use on-device entry.`);
      }
      return { type, message: messageObj };
    }
    throw new Error('Trezor HID: too many rounds');
  }

  async initialize(): Promise<Record<string, unknown>> {
    const res = await this.call('Initialize', {});
    return res.message;
  }

  async getPublicKey(
    path: string,
    coinName = 'Bcash'
  ): Promise<{ xpub: string; label: string }> {
    await this.initialize();
    const res = await this.call('GetPublicKey', {
      address_n: pathToAddressN(path),
      coin_name: coinName,
      script_type: 'SPENDADDRESS',
      show_display: false,
    });
    const xpub = String(res.message.xpub ?? '');
    if (!xpub) throw new Error('Device returned empty xpub');
    return {
      xpub,
      label: String(res.message.root_fingerprint ?? this.family),
    };
  }
}

export function pathToAddressN(path: string): number[] {
  return path
    .replace(/^m\//, '')
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      const hardened = segment.endsWith("'") || segment.endsWith('h');
      const raw = hardened ? segment.slice(0, -1) : segment;
      const index = parseInt(raw, 10);
      return hardened ? (index + 0x80000000) >>> 0 : index;
    });
}

export async function trezorExportAccountXpub(
  network: 'mainnet' | 'chipnet',
  accountPath: string,
  family: HwFamily = 'trezor'
): Promise<{ xpub: string; path: string; via: string; firstAddress?: string }> {
  const session = new TrezorNativeSession(family);
  try {
    const opened = await session.open();
    // EC TrezorPlugin.get_coin_name(): "Bcash" / "Bcash Testnet"
    // Mainnet always uses coin type 145 → path m/44'/145'/0' (account xpub).
    // Account index is the third hardened component (0' = first account).
    const coinName = network === 'chipnet' ? 'Bcash Testnet' : 'Bcash';
    const pathNorm = accountPath.startsWith('m/')
      ? accountPath
      : `m/${accountPath}`;
    const { xpub: rawXpub } = await session.getPublicKey(pathNorm, coinName);

    // Device may return tpub even when path is m/44'/145'/… (chipnet coin name
    // or firmware serialization). Align version bytes to the wallet network so
    // libauth derive + cashaddr prefix match (EC separates key material vs net).
    const { alignHdPublicKeyNetwork } = await import('../HdWalletService');
    const { Network } = await import('../../state/slices/networkSlice');
    const net =
      network === 'chipnet' ? Network.CHIPNET : Network.MAINNET;
    const xpub = alignHdPublicKeyNetwork(net, rawXpub);

    // First receive address is account/0/0 — not "3" (that is BIP32 depth only).
    let firstAddress: string | undefined;
    try {
      const { deriveWatchOnlyAccountPreview } = await import(
        '../../platform/desktop/onboarding/watchOnlyAccountPreview'
      );
      const preview = deriveWatchOnlyAccountPreview(net, xpub);
      firstAddress = preview.receive.address;
    } catch {
      /* preview optional if xpub shape mismatches */
    }

    return {
      xpub,
      path: pathNorm,
      via: opened.via,
      firstAddress,
    };
  } finally {
    await session.close();
  }
}
