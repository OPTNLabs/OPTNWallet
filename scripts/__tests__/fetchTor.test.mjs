// Which Tor version ships to users.
//
// The desktop build broke on all three CI runners when the pinned 15.0.17 was
// deleted upstream — dist.torproject.org keeps only the current stable release.
// The fallback that fixes it has to pick a version out of an HTML directory
// listing, and both ways that can go wrong return a plausible version string
// instead of an error: selecting the alpha, or ordering 15.0.9 above 15.0.19.
// So it is tested against a real captured listing rather than a paraphrase of it.

import { describe, expect, it } from 'vitest';
import { pickLatestStable } from '../fetch-tor.mjs';

/** Captured from https://dist.torproject.org/torbrowser/ (trimmed to the rows). */
const REAL_LISTING = `
<html><head><title>Index of /torbrowser</title></head><body>
<h1>Index of /torbrowser</h1>
<table><tr><th><a href="?C=N;O=D">Name</a></th></tr>
<tr><td><a href="/">Parent Directory</a></td></tr>
<tr><td><a href="15.0.19/">15.0.19/</a></td></tr>
<tr><td><a href="16.0a9/">16.0a9/</a></td></tr>
<tr><td><a href="noscript/">noscript/</a></td></tr>
</table></body></html>
`;

describe('pickLatestStable', () => {
  it('picks the stable release from the real upstream listing', () => {
    expect(pickLatestStable(REAL_LISTING)).toBe('15.0.19');
  });

  it('never ships an alpha, even when it is the newest thing published', () => {
    // 16.0a9 sorts after 15.0.19 by every naive measure and is not a release.
    expect(pickLatestStable(REAL_LISTING)).not.toContain('a');
  });

  it('orders by number, not by string', () => {
    // The bug this guards: "15.0.9" > "15.0.19" lexicographically.
    const listing = `<a href="15.0.9/">x</a><a href="15.0.19/">y</a>`;
    expect(pickLatestStable(listing)).toBe('15.0.19');
  });

  it('compares major before minor', () => {
    const listing = `<a href="9.5.1/">x</a><a href="15.0.1/">y</a>`;
    expect(pickLatestStable(listing)).toBe('15.0.1');
  });

  it('throws rather than returning nothing when the listing has no releases', () => {
    // A silent undefined here would build a URL containing "undefined" and fail
    // much later, with a 404 that looks like the very bug this replaced.
    expect(() => pickLatestStable('<a href="noscript/">noscript</a>')).toThrow();
  });
});
