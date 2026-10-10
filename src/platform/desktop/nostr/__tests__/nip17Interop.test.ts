// P2P CashFusion and chat move to the Rust Nostr layer (crates/optn-nostr)
// while TypeScript peers still run. Both must exchange the same NIP-17 bytes:
// the fixture holds a wrap made by nostr-tools and one made by rust-nostr, and
// each side opens both (the Rust side in optn-nostr's nip17 tests).
import { describe, expect, it } from 'vitest';
import { unwrapEvent } from 'nostr-tools/nip17';
import type { Event } from 'nostr-tools';
import { hexToBytes } from '@noble/hashes/utils';

import fixture from '../../../../../test-vectors/nostr-nip17-interop.json';

describe('NIP-17 between nostr-tools and rust-nostr', () => {
  for (const side of ['from_nostr_tools', 'from_rust'] as const) {
    it(`opens the wrap ${side.replace('_', ' ')}`, () => {
      const rumor = unwrapEvent(
        fixture[side] as unknown as Event,
        hexToBytes(fixture.receiver_secret_hex)
      );
      expect(rumor.kind).toBe(14);
      expect(rumor.pubkey).toBe(fixture.sender_pubkey_hex);
      expect(rumor.content).toBe(fixture.content);
      expect(rumor.tags).toContainEqual(['p', fixture.receiver_pubkey_hex]);
    });
  }
});
