import type {
  AddonManifest,
  AddonPermission,
  AddonCapability,
} from '../../types/addons';

export const ADDON_MANIFEST_SCHEMA_VERSION = 1 as const;

export const ADDON_MANIFEST_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://optn.wallet/schemas/addon-manifest.schema.json',
  title: 'OPTN Addon Manifest',
  type: 'object',
  required: ['id', 'name', 'version', 'permissions', 'contracts'],
  additionalProperties: true,
  properties: {
    schemaVersion: { const: 1 },
    id: { type: 'string', minLength: 1 },
    name: { type: 'string', minLength: 1 },
    version: { type: 'string', minLength: 1 },
    trustTier: { enum: ['restricted', 'reviewed', 'internal'] },
    permissions: {
      type: 'array',
      minItems: 1,
    },
    contracts: {
      type: 'array',
      minItems: 1,
    },
    apps: {
      type: 'array',
    },
  },
} as const;

function validatePermissionShape(
  addonId: string,
  permission: AddonPermission,
  errors: string[]
) {
  if (permission.kind === 'none') return;

  if (permission.kind === 'http') {
    if (!Array.isArray(permission.domains) || permission.domains.length === 0) {
      errors.push(`Addon "${addonId}" http permission must include domains`);
    }
    return;
  }

  if (permission.kind === 'capabilities') {
    if (
      !Array.isArray(permission.capabilities) ||
      permission.capabilities.length === 0
    ) {
      errors.push(
        `Addon "${addonId}" capabilities permission must include capabilities`
      );
    }
    return;
  }

  const unknown = permission as { kind?: unknown };
  errors.push(
    `Addon "${addonId}" has unsupported permission kind: ${String(unknown.kind)}`
  );
}

export function validateAddonManifestAgainstSchema(
  manifest: AddonManifest
): string[] {
  const errors: string[] = [];

  if (!manifest || typeof manifest !== 'object') {
    return ['Manifest must be an object'];
  }

  if (typeof manifest.id !== 'string' || !manifest.id.trim()) {
    errors.push('Manifest id is required');
  }
  if (typeof manifest.name !== 'string' || !manifest.name.trim()) {
    errors.push(`Addon "${manifest.id || '(unknown)'}" missing name`);
  }
  if (typeof manifest.version !== 'string' || !manifest.version.trim()) {
    errors.push(`Addon "${manifest.id || '(unknown)'}" missing version`);
  }
  if (!Array.isArray(manifest.permissions)) {
    errors.push(`Addon "${manifest.id || '(unknown)'}" permissions must be an array`);
  } else {
    for (const permission of manifest.permissions) {
      validatePermissionShape(manifest.id || '(unknown)', permission, errors);
    }
  }
  if (!Array.isArray(manifest.contracts) || manifest.contracts.length === 0) {
    errors.push(`Addon "${manifest.id || '(unknown)'}" must define contracts`);
  }

  if (
    manifest.trustTier !== undefined &&
    manifest.trustTier !== 'restricted' &&
    manifest.trustTier !== 'reviewed' &&
    manifest.trustTier !== 'internal'
  ) {
    errors.push(`Addon "${manifest.id}" has invalid trustTier`);
  }

  return errors;
}

export function validateRequiredCapabilitiesSubset(
  appCaps: AddonCapability[] | undefined,
  grantedCaps: Set<AddonCapability>
): string[] {
  if (!appCaps) return [];
  const errors: string[] = [];
  for (const cap of appCaps) {
    if (!grantedCaps.has(cap)) {
      errors.push(`App requires capability not granted by manifest: ${cap}`);
    }
  }
  return errors;
}
