import type { ChainSource } from '../../platform/desktop/chainSourcesBridge';

/**
 * Do the refusals name Tor?
 *
 * A public source is reached through a verified local SOCKS proxy and is
 * refused outright when there is none — the route fails closed rather than
 * connecting directly, which is the point. Read cold, "requires a verified Tor
 * SOCKS proxy" on every row looks like a broken wallet, so the section says
 * what to do about it. Own infrastructure is dialled directly, which is why
 * that is offered as the other answer.
 *
 * Its own module so the settings file exports components only.
 */
export function refusedForWantOfTor(sources: ChainSource[]): boolean {
  const failures = sources.flatMap((source) => source.failures);
  return (
    failures.length > 0 &&
    failures.every((failure) => /tor/i.test(failure.error))
  );
}
