// The platform CSPRNG for the desktop's fusion code, in one place.
//
// The mix-net shuffle and fusion's timing are part of a round's privacy, so
// neither may come from Math.random, whose state is recoverable from its own
// output, and neither may fall back to it when Web Crypto is missing: a
// fallback that quietly takes over is how Coldcard and the Randstorm wallets
// shipped predictable randomness.

/** The platform CSPRNG, or an error. Never a weaker stand-in. */
export function requireSecureRandom(): Crypto {
  const rng = globalThis.crypto;
  if (!rng?.getRandomValues) {
    throw new Error(
      'Secure randomness is unavailable, so this fusion round cannot run privately.'
    );
  }
  return rng;
}

/**
 * Uniform integer in [0, maxExclusive) from the CSPRNG. Rejection-sampled: the
 * ragged tail past the last whole multiple is discarded rather than folded
 * back with `%`, which would quietly favour the low values.
 */
export function secureRandomInt(maxExclusive: number): number {
  if (maxExclusive <= 1) return 0;
  const rng = requireSecureRandom();
  const limit = Math.floor(0x1_0000_0000 / maxExclusive) * maxExclusive;
  const word = new Uint32Array(1);
  let value = 0;
  do {
    rng.getRandomValues(word);
    value = word[0];
  } while (value >= limit);
  return value % maxExclusive;
}
