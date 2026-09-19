import { invoke } from '@tauri-apps/api/core';

/**
 * Whether a newer desktop release exists on the holder's channel.
 *
 * Which releases count is decided in `optn-core`'s `release_channel`, from the
 * tag the release workflow published — not here. A renderer that parsed
 * version tags itself would be a second copy of the rule that decides what a
 * holder is offered, and the two would eventually disagree about whether a
 * prerelease is one.
 */
export type UpdateCheck = {
  /**
   * Whether this build can verify an update's signature, and so whether it may
   * install one.
   *
   * False when no public key is configured. The check still works and still
   * links to the release page; what is withheld is the install button, because
   * installing what cannot be verified is the whole danger.
   */
  verified_install: boolean;
  /** The running build, as a tag. */
  current: string;
  channel: 'stable' | 'beta' | 'alpha';
  /** The newer release to offer, if any. */
  available: string | null;
  releases_url: string;
  /** Why no check was made, when none was. */
  unavailable: string | null;
};

export function checkForUpdate(
  beta: boolean,
  alpha: boolean
): Promise<UpdateCheck> {
  return invoke('optn_check_for_update', { beta, alpha });
}

/**
 * Download and install the update, verifying its signature first.
 *
 * Only offered when `verified_install` is true. Every byte is checked against
 * the public key compiled into this build before anything runs; a missing or
 * wrong signature fails rather than warns. Resolves with the version installed.
 */
export function installUpdate(): Promise<string> {
  return invoke('optn_install_update');
}
