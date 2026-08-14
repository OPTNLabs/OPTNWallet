import type {
  AddonManifest,
  AddonPermission,
  AddonCapability,
} from '../../types/addons';
import { SUPPORTED_LOCALES, type SupportedLocale } from '../../i18n/types';

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
    },
    apps: {
      type: 'array',
    },
    localeBundles: {
      type: 'array',
      maxItems: SUPPORTED_LOCALES.length,
    },
  },
} as const;

const MAX_ADDON_LOCALE_MESSAGES = 2048;
const MAX_ADDON_LOCALE_KEY_LENGTH = 256;
const MAX_ADDON_LOCALE_VALUE_LENGTH = 8192;

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

function validateLocaleBundles(
  addonId: string,
  bundles: unknown,
  errors: string[]
): void {
  if (bundles === undefined) return;
  if (!Array.isArray(bundles)) {
    errors.push(`Addon "${addonId}" localeBundles must be an array`);
    return;
  }

  const seenLocales = new Set<string>();
  for (const rawBundle of bundles) {
    if (!rawBundle || typeof rawBundle !== 'object') {
      errors.push(`Addon "${addonId}" has an invalid locale bundle`);
      continue;
    }

    const bundle = rawBundle as {
      locale?: unknown;
      messages?: unknown;
    };
    const locale = bundle.locale;
    if (
      typeof locale !== 'string' ||
      !SUPPORTED_LOCALES.includes(locale as SupportedLocale)
    ) {
      errors.push(`Addon "${addonId}" has an unsupported locale bundle`);
    } else if (seenLocales.has(locale)) {
      errors.push(`Addon "${addonId}" has duplicate locale bundle: ${locale}`);
    } else {
      seenLocales.add(locale);
    }

    if (
      !bundle.messages ||
      typeof bundle.messages !== 'object' ||
      Array.isArray(bundle.messages)
    ) {
      errors.push(`Addon "${addonId}" locale bundle must contain messages`);
      continue;
    }

    const entries = Object.entries(bundle.messages as Record<string, unknown>);
    if (entries.length === 0) {
      errors.push(`Addon "${addonId}" locale bundle must not be empty`);
    }
    if (entries.length > MAX_ADDON_LOCALE_MESSAGES) {
      errors.push(
        `Addon "${addonId}" locale bundle exceeds ${MAX_ADDON_LOCALE_MESSAGES} messages`
      );
    }
    for (const [key, value] of entries) {
      if (!key.trim() || key.length > MAX_ADDON_LOCALE_KEY_LENGTH) {
        errors.push(`Addon "${addonId}" has an invalid locale message key`);
        continue;
      }
      if (
        typeof value !== 'string' ||
        value.length > MAX_ADDON_LOCALE_VALUE_LENGTH
      ) {
        errors.push(
          `Addon "${addonId}" has an invalid locale message value for "${key}"`
        );
      }
    }
  }
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
    errors.push(
      `Addon "${manifest.id || '(unknown)'}" permissions must be an array`
    );
  } else {
    for (const permission of manifest.permissions) {
      validatePermissionShape(manifest.id || '(unknown)', permission, errors);
    }
  }
  if (!Array.isArray(manifest.contracts)) {
    errors.push(
      `Addon "${manifest.id || '(unknown)'}" contracts must be an array`
    );
  }

  if (
    manifest.trustTier !== undefined &&
    manifest.trustTier !== 'restricted' &&
    manifest.trustTier !== 'reviewed' &&
    manifest.trustTier !== 'internal'
  ) {
    errors.push(`Addon "${manifest.id}" has invalid trustTier`);
  }

  validateLocaleBundles(
    manifest.id || '(unknown)',
    manifest.localeBundles,
    errors
  );

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
