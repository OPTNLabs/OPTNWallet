import { Buffer } from 'buffer';
import { encodeMessage, parseConfigure } from '@trezor/protobuf';
import messagesJson from '@trezor/protobuf/messages.json';
import { bridge, v1 } from '@trezor/protocol';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as native from '../nativeHw';
import * as bridgeTransport from '../trezorBridge';
import { TrezorNativeSession } from '../TrezorNativeSession';

vi.mock('../nativeHw', () => ({
  canUseNativeHw: vi.fn(() => true),
  findFirstDevice: vi.fn(),
  hwOpen: vi.fn(() => 1),
  hwClose: vi.fn(),
  hwRead: vi.fn(),
  hwWrite: vi.fn(),
  trezorWebUsbEnumerate: vi.fn(() => []),
  trezorWebUsbOpen: vi.fn(() => 2),
  trezorWebUsbClose: vi.fn(),
  trezorWebUsbRead: vi.fn(),
  trezorWebUsbWrite: vi.fn(),
}));
vi.mock('../trezorBridge', () => ({
  bridgePing: vi.fn(() => ({ version: 'test' })),
  bridgeEnumerate: vi.fn(() => [{ path: 'test-device' }]),
  bridgeAcquire: vi.fn(() => 'test-session'),
  bridgeRelease: vi.fn(),
  bridgeCall: vi.fn(),
}));

const messages = parseConfigure(messagesJson);
function encode(name: string, data: Record<string, unknown>, codec = v1) {
  const { message, messageType } = encodeMessage(messages, name, data);
  return Buffer.from(codec.encode(Buffer.from(message), { messageType }));
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

it.each(['hid', 'webusb'] as const)(
  'preserves vendor framing across single and multiple %s reports',
  async (transport) => {
    vi.mocked(native.findFirstDevice).mockResolvedValue(
      transport === 'hid'
        ? ({ path: 'test-device', family: 'trezor' } as native.HwDeviceInfo)
        : null
    );
    vi.mocked(native.trezorWebUsbEnumerate).mockResolvedValue(
      transport === 'webusb'
        ? [
            {
              path: 'test-device',
              product: 'Trezor',
            } as native.TrezorWebUsbInfo,
          ]
        : []
    );
    const read = vi.mocked(
      transport === 'hid' ? native.hwRead : native.trezorWebUsbRead
    );
    const write = vi.mocked(
      transport === 'hid' ? native.hwWrite : native.trezorWebUsbWrite
    );
    const session = new TrezorNativeSession();
    await session.open();
    for (const message of ['', 'public protocol payload '.repeat(8)]) {
      const response = encode('Success', { message });
      // The codec includes the first report marker; continuation reports add one.
      const reports = [response.subarray(0, 64)];
      for (let offset = 64; offset < response.length; offset += 63) {
        reports.push(
          Buffer.concat([
            Buffer.from([0x3f]),
            response.subarray(offset, offset + 63),
          ])
        );
      }
      for (const report of reports) {
        const padded = Buffer.alloc(64);
        report.copy(padded);
        const wireReport =
          transport === 'hid'
            ? Buffer.concat([Buffer.from([0]), padded])
            : padded;
        read.mockResolvedValueOnce(wireReport.toString('hex'));
      }
      read.mockRejectedValueOnce(new Error('read beyond complete response'));
      write.mockClear();
      await expect(session.call('Ping', { message })).resolves.toEqual({
        type: 'Success',
        message: { message },
      });
      const sent = write.mock.calls.map(([, hex]) => Buffer.from(hex, 'hex'));
      expect(
        sent.every((report) => report.length === 64 && report[0] === 0x3f)
      ).toBe(true);
      expect(sent[0].subarray(0, 3).toString('hex')).toBe('3f2323');
      const request = encode('Ping', { message });
      expect(
        Buffer.concat(
          sent.map((report, index) => (index ? report.subarray(1) : report))
        ).subarray(0, request.length)
      ).toEqual(request);
      expect(read).toHaveBeenCalledTimes(reports.length);
      read.mockReset();
    }
    await session.close();
  }
);

it('rejects malformed native reports before reading another packet', async () => {
  vi.mocked(native.findFirstDevice).mockResolvedValue(null);
  vi.mocked(native.trezorWebUsbEnumerate).mockResolvedValue([
    { path: 'test-device', product: 'Trezor' } as native.TrezorWebUsbInfo,
  ]);
  const session = new TrezorNativeSession();
  await session.open();
  const complete = Buffer.alloc(64);
  encode('Success', { message: 'public' }).copy(complete);
  for (const packet of [
    complete.subarray(0, 63),
    Buffer.concat([complete, Buffer.from([0])]),
    Buffer.alloc(64),
    Buffer.from([0x3f, ...new Array(63).fill(0)]),
  ]) {
    vi.mocked(native.trezorWebUsbRead)
      .mockReset()
      .mockResolvedValueOnce(packet.toString('hex'));
    await expect(session.call('Ping')).rejects.toThrow(
      /invalid report|Malformed protocol/
    );
    expect(native.trezorWebUsbRead).toHaveBeenCalledTimes(1);
  }
  await session.close();
});

it.each(['hid', 'webusb'] as const)(
  'bounds %s response allocation and the whole multi-report read',
  async (transport) => {
    vi.mocked(native.findFirstDevice).mockResolvedValue(
      transport === 'hid'
        ? ({ path: 'test-device', family: 'trezor' } as native.HwDeviceInfo)
        : null
    );
    vi.mocked(native.trezorWebUsbEnumerate).mockResolvedValue(
      transport === 'webusb'
        ? [
            {
              path: 'test-device',
              product: 'Trezor',
            } as native.TrezorWebUsbInfo,
          ]
        : []
    );
    const read = vi.mocked(
      transport === 'hid' ? native.hwRead : native.trezorWebUsbRead
    );
    const session = new TrezorNativeSession();
    await session.open();
    const response = encode('Success', { message: 'public'.repeat(50) });
    for (const length of [1024 * 1024 + 1, 0xffffffff]) {
      const oversized = Buffer.from(response.subarray(0, 64));
      oversized.writeUInt32BE(length, 5);
      read.mockReset().mockResolvedValueOnce(oversized.toString('hex'));
      await expect(session.call('Ping')).rejects.toThrow('transport limit');
      expect(read).toHaveBeenCalledTimes(1);
    }

    // Each packet arrives within 100ms, but the complete response does not.
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    let packet = 0;
    read.mockReset().mockImplementation(async () => {
      now += 60;
      return (
        packet++ === 0
          ? response.subarray(0, 64)
          : Buffer.concat([Buffer.from([0x3f]), response.subarray(64, 127)])
      ).toString('hex');
    });
    await expect(session.call('Ping', {}, { timeoutMs: 100 })).rejects.toThrow(
      'response timed out'
    );
    expect(read.mock.calls.map(([, timeout]) => timeout)).toEqual([100, 40]);
    read.mockReset();
    await expect(session.call('Ping', {}, { timeoutMs: 0 })).rejects.toThrow(
      'invalid response timeout'
    );
    expect(read).not.toHaveBeenCalled();
    await session.close();
  }
);

it('uses the vendor Bridge codec for calls and ButtonAck', async () => {
  vi.mocked(native.findFirstDevice).mockResolvedValue(null);
  vi.mocked(native.trezorWebUsbEnumerate).mockResolvedValue([]);
  vi.mocked(bridgeTransport.bridgeCall)
    .mockResolvedValueOnce(encode('ButtonRequest', {}, bridge).toString('hex'))
    .mockResolvedValueOnce(
      encode('Success', { message: 'public response' }, bridge).toString('hex')
    );
  const session = new TrezorNativeSession();
  await session.open();
  await expect(
    session.call('Ping', { message: 'public request' })
  ).resolves.toEqual({
    type: 'Success',
    message: { message: 'public response' },
  });
  expect(bridgeTransport.bridgeCall).toHaveBeenNthCalledWith(
    1,
    'test-session',
    encode('Ping', { message: 'public request' }, bridge).toString('hex')
  );
  expect(bridgeTransport.bridgeCall).toHaveBeenNthCalledWith(
    2,
    'test-session',
    encode('ButtonAck', {}, bridge).toString('hex')
  );
  const malformed = encode('Success', { message: 'public' }, bridge);
  malformed.writeUInt32BE(malformed.readUInt32BE(2) + 1, 2);
  vi.mocked(bridgeTransport.bridgeCall).mockResolvedValueOnce(
    malformed.toString('hex')
  );
  await expect(session.call('Ping')).rejects.toThrow('invalid payload length');
  const valid = encode('Success', { message: 'public' }, bridge).toString(
    'hex'
  );
  for (const invalid of [valid + 'z', valid + '0']) {
    vi.mocked(bridgeTransport.bridgeCall).mockResolvedValueOnce(invalid);
    await expect(session.call('Ping')).rejects.toThrow(
      'invalid response encoding'
    );
  }
  malformed.writeUInt32BE(1024 * 1024 + 1, 2);
  vi.mocked(bridgeTransport.bridgeCall).mockResolvedValueOnce(
    malformed.toString('hex')
  );
  await expect(session.call('Ping')).rejects.toThrow('transport limit');
  await session.close();
});
