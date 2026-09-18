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
