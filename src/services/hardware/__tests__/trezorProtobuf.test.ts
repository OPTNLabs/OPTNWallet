import { Buffer } from 'buffer';
import { decodeMessage, encodeMessage, parseConfigure } from '@trezor/protobuf';
import messagesJson from '@trezor/protobuf/messages.json';
import { expect, it } from 'vitest';

it('preserves BCH wire bytes and 64-bit amounts with the patched protobuf runtime', () => {
  const messages = parseConfigure(messagesJson);
  const address = {
    address_n: [2147483692, 2147483793, 2147483648, 0, 5],
    coin_name: 'Bitcoin Cash',
    show_display: true,
  };
  // Proto2 repeated uint32 fields are unpacked; hardened path indices must
  // retain their high bit. These are protocol bytes, not a device response.
  const addressBytes = Buffer.from(
    '08ac8080800808918180800808808080800808000805120c426974636f696e20436173681801',
    'hex'
  );
  const encoded = encodeMessage(messages, 'GetAddress', address);
  expect(encoded.messageType).toBe(29);
  expect(encoded.message).toEqual(addressBytes);
  expect(decodeMessage(messages, 29, addressBytes)).toMatchObject({
    type: 'GetAddress',
    message: address,
  });

  const transaction = {
    tx: { bin_outputs: [{ amount: 4294967296, script_pubkey: '6a0142' }] },
  };
  const transactionBytes = Buffer.from('0a0d1a0b08808080801012036a0142', 'hex');
  const ack = encodeMessage(messages, 'TxAck', transaction);
  expect(ack.messageType).toBe(22);
  expect(ack.message).toEqual(transactionBytes);
  expect(decodeMessage(messages, 22, transactionBytes)).toMatchObject({
    type: 'TxAck',
    message: transaction,
  });
});
