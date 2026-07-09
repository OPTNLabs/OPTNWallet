export const PRIVKEY_UNLOCK_TAPS = 10;

function clampTapCount(pubKeyTapCount: number): number {
  if (!Number.isFinite(pubKeyTapCount)) return 0;
  return Math.min(PRIVKEY_UNLOCK_TAPS, Math.max(0, Math.trunc(pubKeyTapCount)));
}

export function getRemainingPrivKeyUnlockTaps(pubKeyTapCount: number): number {
  return PRIVKEY_UNLOCK_TAPS - clampTapCount(pubKeyTapCount);
}

export function getPrivKeyUnlockToastMessage(
  pubKeyTapCount: number
): string | null {
  const normalizedTapCount = clampTapCount(pubKeyTapCount);
  const remainingTaps = PRIVKEY_UNLOCK_TAPS - normalizedTapCount;
  if (remainingTaps <= 0 || remainingTaps > 5) return null;

  return `PubKey taps: ${normalizedTapCount}/${PRIVKEY_UNLOCK_TAPS}. ${remainingTaps} more tap${
    remainingTaps === 1 ? '' : 's'
  } to reveal PrivKey.`;
}

export function shouldShowPrivKeyButton(isPrivKeyUnlocked: boolean): boolean {
  return isPrivKeyUnlocked;
}
