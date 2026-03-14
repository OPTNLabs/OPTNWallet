// src/services/AddonsRegistry.ts
import type {
  AddonCapability,
  AddonManifest,
  AddonContractDefinition,
  ResolvedAddonContractDefinition,
  ResolvedAddonAppDefinition,
} from '../types/addons';
import {
  getAddonGrantedCapabilities,
  validateAddonPermissions,
} from './AddonsAllowlist';
import { validateAddonManifestAgainstSchema } from './addons/AddonManifestSchema';

/**
 * v1 Registry:
 * - Loads built-in addons (static import)
 * - Validates permissions against global allowlist
 * - Exposes addon contracts to the rest of the app
 *
 * Later:
 * - Install/uninstall from marketplace
 * - Persist enabled/disabled state in DB
 * - Signature verification of addon packages
 */
type AddonsRegistryApi = {
  init: () => Promise<void>;
  getAddons: () => AddonManifest[];
  getContracts: () => ResolvedAddonContractDefinition[];
  getApps: () => ResolvedAddonAppDefinition[];
};

let initialized = false;
let manifests: AddonManifest[] = [];
let registrySingleton: AddonsRegistryApi | null = null;

export default function AddonsRegistry() {
  if (registrySingleton) return registrySingleton;

  registrySingleton = {
    init,
    getAddons,
    getContracts,
    getApps,
  };
  return registrySingleton;

  async function init(): Promise<void> {
    if (initialized) return;

    // v1: built-in only
    const { BUILTIN_ADDONS } = await import('../addons/builtin');

    // Validate + de-dupe
    const seenAddonIds = new Set<string>();
    const seenFullContractIds = new Set<string>();
    const valid: AddonManifest[] = [];

    for (const m of BUILTIN_ADDONS) {
      if (!m?.id) continue;

      validateManifestShape(m);
      const schemaErrors = validateAddonManifestAgainstSchema(m);
      if (schemaErrors.length) {
        throw new Error(
          `Addon "${m.id}" failed schema checks: ${schemaErrors.join('; ')}`
        );
      }

      validateAddonPermissions(m);
      const manifestCapabilities = getAddonGrantedCapabilities(m);

      // Validate apps (optional)
      if (m.apps) {
        if (!Array.isArray(m.apps)) {
          throw new Error(`Addon "${m.id}" apps must be an array`);
        }
        const seenAppIds = new Set<string>();
        for (const a of m.apps) {
          if (!a || typeof a !== 'object') {
            throw new Error(`Addon "${m.id}" has invalid app entry`);
          }
          if (typeof a.id !== 'string' || !a.id.trim()) {
            throw new Error(`Addon "${m.id}" app missing id`);
          }
          if (seenAppIds.has(a.id)) {
            throw new Error(
              `Duplicate app id within addon "${m.id}": ${a.id}`
            );
          }
          seenAppIds.add(a.id);

          if (typeof a.name !== 'string' || !a.name.trim()) {
            throw new Error(
              `Addon "${m.id}" app "${a.id}" missing name`
            );
          }
          if (a.kind !== 'declarative') {
            throw new Error(
              `Addon "${m.id}" app "${a.id}" has unsupported kind`
            );
          }

          const requiredCapabilities = a.requiredCapabilities;
          if (requiredCapabilities !== undefined) {
            if (
              !Array.isArray(requiredCapabilities) ||
              requiredCapabilities.length === 0
            ) {
              throw new Error(
                `Addon "${m.id}" app "${a.id}" requiredCapabilities must be a non-empty array when provided`
              );
            }

            const seenCapabilities = new Set<string>();
            for (const cap of requiredCapabilities as AddonCapability[]) {
              if (typeof cap !== 'string' || !cap.trim()) {
                throw new Error(
                  `Addon "${m.id}" app "${a.id}" has invalid required capability`
                );
              }
              if (seenCapabilities.has(cap)) {
                throw new Error(
                  `Addon "${m.id}" app "${a.id}" has duplicate required capability: ${cap}`
                );
              }
              seenCapabilities.add(cap);

              if (!manifestCapabilities.has(cap)) {
                throw new Error(
                  `Addon "${m.id}" app "${a.id}" requires capability not granted by manifest: ${cap}`
                );
              }
            }
          }
        }
      }

      if (seenAddonIds.has(m.id)) {
        throw new Error(`Duplicate addon id detected: ${m.id}`);
      }

      // validate contract ids within addon + across all addons
      const seenContractIdsWithinAddon = new Set<string>();
      for (const c of m.contracts) {
        validateContractShape(m, c);

        if (seenContractIdsWithinAddon.has(c.id)) {
          throw new Error(
            `Duplicate contract id within addon "${m.id}": ${c.id}`
          );
        }
        seenContractIdsWithinAddon.add(c.id);

        const fullId = `${m.id}:${c.id}`;
        if (seenFullContractIds.has(fullId)) {
          throw new Error(
            `Duplicate addon contract fullId detected: ${fullId}`
          );
        }
        seenFullContractIds.add(fullId);
      }

      seenAddonIds.add(m.id);
      valid.push(m);
    }

    manifests = valid;
    initialized = true;
  }

  function getAddons(): AddonManifest[] {
    return manifests.slice();
  }

  function getContracts(): ResolvedAddonContractDefinition[] {
    const contracts: ResolvedAddonContractDefinition[] = [];
    for (const m of manifests) {
      for (const c of m.contracts) {
        contracts.push({
          ...(c as AddonContractDefinition),
          addonId: m.id,
          fullId: `${m.id}:${c.id}`,
        });
      }
    }
    return contracts;
  }

  function validateManifestShape(m: AddonManifest): void {
    if (typeof m.id !== 'string' || !m.id.trim()) {
      throw new Error(`Invalid addon manifest: missing id`);
    }
    if (typeof m.name !== 'string' || !m.name.trim()) {
      throw new Error(`Addon "${m.id}" missing name`);
    }
    if (typeof m.version !== 'string' || !m.version.trim()) {
      throw new Error(`Addon "${m.id}" missing version`);
    }
    if (!Array.isArray(m.permissions)) {
      throw new Error(`Addon "${m.id}" permissions must be an array`);
    }
    if (!Array.isArray(m.contracts) || m.contracts.length === 0) {
      throw new Error(`Addon "${m.id}" must include at least one contract`);
    }
  }

  function validateContractShape(
    m: AddonManifest,
    cRaw: unknown
  ): asserts cRaw is AddonContractDefinition {
    const c = cRaw as Record<string, unknown>;

    const contractId =
      typeof c.id === 'string' && c.id.trim() ? c.id : '(unknown)';

    if (!c || typeof c !== 'object') {
      throw new Error(`Addon "${m.id}" has invalid contract entry`);
    }
    if (typeof c.id !== 'string' || !c.id.trim()) {
      throw new Error(`Addon "${m.id}" has contract with missing id`);
    }
    if (typeof c.name !== 'string' || !c.name.trim()) {
      throw new Error(`Addon "${m.id}" contract "${contractId}" missing name`);
    }

    if (c.cashscriptArtifact === undefined) {
      throw new Error(
        `Addon "${m.id}" contract "${contractId}" missing cashscriptArtifact`
      );
    }
    if (
      typeof c.cashscriptArtifact !== 'object' ||
      c.cashscriptArtifact === null
    ) {
      throw new Error(
        `Addon "${m.id}" contract "${contractId}" has invalid cashscriptArtifact`
      );
    }

    if (!Array.isArray(c.functions)) {
      throw new Error(
        `Addon "${m.id}" contract "${contractId}" functions must be an array`
      );
    }
  }

  function getApps(): ResolvedAddonAppDefinition[] {
    const out: ResolvedAddonAppDefinition[] = [];
    for (const m of manifests) {
      const apps = m.apps ?? [];
      for (const a of apps) {
        out.push({
          ...a,
          addonId: m.id,
          fullId: `${m.id}:${a.id}`,
        });
      }
    }
    return out;
  }
}
