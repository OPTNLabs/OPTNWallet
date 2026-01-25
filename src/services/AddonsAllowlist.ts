// src/services/AddonsAllowlist.ts
import type { AddonManifest, AddonPermission } from '../types/addons';

/**
 * Global allowlist for addon HTTP calls.
 * v1: hard-coded list (you can later move to config/DB/UI settings).
 *
 * IMPORTANT: no wildcards.
 */
const ALLOWED_ADDON_HTTP_DOMAINS = new Set<string>([
  // Put your infra endpoints here when ready, examples:
  // 'ipfs-gateway.optnlabs.com',
  // 'bcmr.optnlabs.com',
  // 'chaingraph.optnlabs.com',
]);

function normalizeDomain(d: string): string {
  return d.trim().toLowerCase();
}

function isIpLiteral(host: string): boolean {
  // quick & conservative checks
  // IPv4: digits and dots; IPv6: contains colon
  const h = host.trim();
  if (!h) return false;
  if (h.includes(':')) return true; // IPv6-ish
  return /^[0-9.]+$/.test(h); // IPv4-ish
}

function isDisallowedHost(host: string): boolean {
  const h = normalizeDomain(host);
  if (!h) return true;
  if (h === 'localhost') return true;
  if (h.endsWith('.local')) return true;
  if (isIpLiteral(h)) return true;
  return false;
}

/**
 * Exhaustiveness helper.
 * We intentionally keep this fail-closed: unknown permission kinds must be rejected.
 */
function assertNever(_x: never, message: string): never {
  throw new Error(message);
}

export function validateAddonPermissions(manifest: AddonManifest): void {
  for (const perm of manifest.permissions) {
    switch (perm.kind) {
      case 'none': {
        continue;
      }

      case 'http': {
        if (!Array.isArray(perm.domains) || perm.domains.length === 0) {
          throw new Error(
            `Addon "${manifest.id}" requests http permission with no domains`
          );
        }

        for (const raw of perm.domains) {
          const domain = normalizeDomain(raw);

          // reject obvious bad inputs
          if (!domain || domain.includes('/') || domain.includes('http')) {
            throw new Error(
              `Addon "${manifest.id}" has invalid http domain: "${raw}"`
            );
          }

          if (isDisallowedHost(domain)) {
            throw new Error(
              `Addon "${manifest.id}" requests disallowed host: "${domain}"`
            );
          }

          if (!ALLOWED_ADDON_HTTP_DOMAINS.has(domain)) {
            throw new Error(
              `Addon "${manifest.id}" requests non-allowlisted domain: "${domain}"`
            );
          }
        }

        continue;
      }

      default: {
        // Fail-closed for any future permission kinds.
        assertNever(
          perm as never,
          `Unsupported addon permission: ${(perm as AddonPermission as any).kind}`
        );
      }
    }
  }
}

/**
 * Helper for runtime checks (later: if addons can request a URL call).
 */
export function assertUrlAllowedForAddon(
  manifest: AddonManifest,
  url: string
): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }

  // Strongly prefer https for addon traffic.
  // If you later need http for local dev, gate it behind a dev flag, not manifest.
  if (parsed.protocol !== 'https:') {
    throw new Error(
      `Addon "${manifest.id}" attempted non-https URL: ${parsed.protocol}`
    );
  }

  // Disallow credentials in URL
  if (parsed.username || parsed.password) {
    throw new Error(`Addon "${manifest.id}" attempted URL with credentials`);
  }

  const hostname = normalizeDomain(parsed.hostname);

  if (isDisallowedHost(hostname)) {
    throw new Error(
      `Addon "${manifest.id}" attempted disallowed host: ${hostname}`
    );
  }

  // addon must request http permission for that host
  const httpPerm = manifest.permissions.find(
    (p): p is Extract<AddonPermission, { kind: 'http' }> => p.kind === 'http'
  );

  if (!httpPerm) {
    throw new Error(`Addon "${manifest.id}" has no http permission`);
  }

  const requested = new Set(httpPerm.domains.map(normalizeDomain));
  if (!requested.has(hostname)) {
    throw new Error(
      `Addon "${manifest.id}" attempted URL outside its requested domains: ${hostname}`
    );
  }

  if (!ALLOWED_ADDON_HTTP_DOMAINS.has(hostname)) {
    throw new Error(
      `Addon "${manifest.id}" attempted URL outside global allowlist: ${hostname}`
    );
  }
}
