/**
 * P2P CashFusion v4 — EC component plane (Phase B helpers).
 *
 * Live rounds still use ROUND_MSG_VERSION = 3. This module locks the v4 rule:
 *   blind credential message = sha256(serialized Electron Cash Component)
 * and shares golden vectors with native `fusion/p2p_component.rs`.
 *
 * Spec: docs/p2p-ec-component-plane-v4.md
 */
import { binToHex, hexToBin, sha256 } from '@bitauth/libauth';

/** Renderer/native protocol tag for encode responses (not the round msg version). */
export const P2P_COMPONENT_PROTOCOL = 'p2p-v4-ec-component' as const;

/**
 * Target round message version once Phases C–F land.
 * Do NOT assign this to ROUND_MSG_VERSION until anonymous redeem works.
 */
export const ROUND_MSG_VERSION_V4 = 4 as const;

/**
 * Electron Cash protobuf wire vector for one Input Component
 * (salt_commitment=0x11*32, prev_txid wire=0xaa*32, index=3, pubkey=0x02*33, amount=200000).
 * Locked in native `components.rs` + `p2p_component.rs` tests.
 */
export const EC_INPUT_COMPONENT_GOLDEN_HEX =
  '0a20' +
  '1111111111111111111111111111111111111111111111111111111111111111' +
  '124b0a20' +
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' +
  '10031a21' +
  '020202020202020202020202020202020202020202020202020202020202020202' +
  '20c09a0c';

/**
 * Blind-credential message for v4: SHA-256 over the raw component bytes.
 * Not a UTF-8 domain string (v3). Not RFC6979.
 */
export function componentBlindMessageHash(
  componentBytes: Uint8Array
): Uint8Array {
  if (componentBytes.length === 0) {
    throw new Error('component bytes must be non-empty');
  }
  if (componentBytes.length > 200 * 1024) {
    throw new Error('component bytes exceed fusion max message size');
  }
  return new Uint8Array(sha256.hash(componentBytes));
}

export function componentBlindMessageHashHex(componentHex: string): string {
  return binToHex(componentBlindMessageHash(hexToBin(componentHex)));
}
