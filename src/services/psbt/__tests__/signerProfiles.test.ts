// The signer profile list is a claim about devices, so it is checked against
// what the rest of the codebase actually does rather than left as prose.

import { describe, expect, it } from 'vitest';

import {
  SIGHASH_ALL_FORKID_ANYONECANPAY,
  SIGNER_PROFILES,
  signerProfile,
  verifiedSigners,
} from '../signerProfiles';
import { WATCH_ONLY_SIGHASH_TYPE } from '../watchOnlySend';

describe('signer profiles', () => {
  it('agrees with the sighash the send path actually requests', () => {
    // If these drift, a profile would promise a device something the builder
    // never asks for and the mismatch would only appear as a rejected import.
    for (const profile of SIGNER_PROFILES) {
      expect(profile.sighashType).toBe(WATCH_ONLY_SIGHASH_TYPE);
    }
    expect(WATCH_ONLY_SIGHASH_TYPE).toBe(SIGHASH_ALL_FORKID_ANYONECANPAY);
  });

  it('requires the parent transaction everywhere the builder does', () => {
    // buildWatchOnlyPsbt refuses to build without it, so a profile claiming
    // otherwise would describe a configuration that cannot be produced.
    for (const profile of SIGNER_PROFILES) {
      expect(profile.requiresParentTransaction).toBe(true);
    }
  });

  it('marks only the signer that has been round-tripped as verified', () => {
    // SeedCash has been driven end to end against its own signing code.
    // Keystone has not been near a device, and saying so in data is what stops
    // the UI implying parity it has not earned.
    expect(verifiedSigners().map((profile) => profile.id)).toEqual(['seedcash']);
  });

  it('makes every unverified signer explain itself', () => {
    for (const profile of SIGNER_PROFILES) {
      if (!profile.signingVerified) {
        expect(profile.signingCaveat).toBeTruthy();
      }
    }
  });

  it('records which imports carry the fingerprint, since that drives the UI', () => {
    // This is the difference that earns Keystone a separate option: a bare
    // xPub cannot supply it, a BC-UR account export can.
    const seedcash = signerProfile('seedcash');
    expect(seedcash.accountImport).toBe('xpub');
    expect(seedcash.suppliesMasterFingerprint).toBe(false);
    expect(seedcash.suppliesAccountPath).toBe(false);

    const keystone = signerProfile('keystone');
    expect(keystone.accountImport).toBe('ur-account');
    expect(keystone.suppliesMasterFingerprint).toBe(true);
    expect(keystone.suppliesAccountPath).toBe(true);
  });

  it('throws on an unknown id rather than returning a silent default', () => {
    expect(() =>
      signerProfile('generic-psbt' as Parameters<typeof signerProfile>[0])
    ).toThrow(/Unknown signer profile/);
  });
});
