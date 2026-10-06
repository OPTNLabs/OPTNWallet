import type { AddonCapability, AddonManifest } from './types.js';
import { AddonSDKError } from './transport.js';
import { ADDON_SDK_CAPABILITIES } from './contract.js';
import { validateCashScriptArtifact } from './cashscript.js';

const KNOWN_CAPABILITIES: ReadonlySet<AddonCapability> = new Set(
  ADDON_SDK_CAPABILITIES
);

function invalid(message: string): never {
  throw new AddonSDKError({ code: 'INVALID_REQUEST', message });
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    invalid(`${label} must be a non-empty string`);
  }
  if (value.length > 256) invalid(`${label} is too long`);
  return value;
}

function validateDomain(value: unknown): string {
  const domain = nonEmptyString(value, 'HTTP domain').trim().toLowerCase();
  if (
    domain.includes('/') ||
    domain.includes('\\') ||
    domain.includes('*') ||
    domain.includes(':') ||
    /^[0-9.]+$/.test(domain) ||
    domain === 'localhost' ||
    domain.endsWith('.local')
  ) {
    invalid(`HTTP domain is not a host name: ${domain}`);
  }
  return domain;
}

/**
 * Validate the package-level manifest shape before host policy is consulted.
 * This does not grant permissions or establish publisher identity.
 */
export function validateAddonManifest(
  value: unknown
): asserts value is AddonManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    invalid('Add-on manifest must be an object');
  }
  const manifest = value as Record<string, unknown>;
  nonEmptyString(manifest.id, 'Add-on id');
  nonEmptyString(manifest.name, 'Add-on name');
  nonEmptyString(manifest.version, 'Add-on version');
  if (manifest.schemaVersion !== undefined && manifest.schemaVersion !== 1) {
    invalid('Unsupported add-on manifest schema version');
  }
  if (!Array.isArray(manifest.contracts)) {
    invalid('Add-on manifest contracts must be an array');
  }
  manifest.contracts.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      invalid(`Contract declaration ${index} must be an object`);
    }
    const declaration = entry as Record<string, unknown>;
    nonEmptyString(declaration.id, `Contract declaration ${index} id`);
    validateCashScriptArtifact(declaration.artifact);
  });
  if (manifest.trustTier === 'internal') {
    invalid('Internal trust tier is host-private');
  }
  if (
    manifest.trustTier !== undefined &&
    manifest.trustTier !== 'restricted' &&
    manifest.trustTier !== 'reviewed'
  ) {
    invalid('Invalid add-on trust tier');
  }
  if (!Array.isArray(manifest.permissions)) {
    invalid('Add-on manifest permissions must be an array');
  }

  for (const permission of manifest.permissions) {
    if (
      !permission ||
      typeof permission !== 'object' ||
      Array.isArray(permission)
    ) {
      invalid('Invalid add-on permission');
    }
    const entry = permission as Record<string, unknown>;
    if (entry.kind === 'none') continue;
    if (entry.kind === 'http') {
      if (!Array.isArray(entry.domains) || entry.domains.length === 0) {
        invalid('HTTP permission requires at least one domain');
      }
      const domains = entry.domains.map(validateDomain);
      if (new Set(domains).size !== domains.length) {
        invalid('HTTP permission contains duplicate domains');
      }
      continue;
    }
    if (entry.kind === 'capabilities') {
      if (
        !Array.isArray(entry.capabilities) ||
        entry.capabilities.length === 0
      ) {
        invalid('Capability permission requires at least one capability');
      }
      const capabilities = entry.capabilities as unknown[];
      const seen = new Set<string>();
      for (const capability of capabilities) {
        if (
          typeof capability !== 'string' ||
          !KNOWN_CAPABILITIES.has(capability as AddonCapability) ||
          seen.has(capability)
        ) {
          invalid(
            `Invalid or duplicate add-on capability: ${String(capability)}`
          );
        }
        seen.add(capability);
      }
      continue;
    }
    invalid('Unsupported add-on permission kind');
  }
}
