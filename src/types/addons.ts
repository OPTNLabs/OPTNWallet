// src/types/addons.ts

/**
 * Marketplace Add-ons v1
 *
 * Goals:
 * - Allow add-ons to contribute contracts + callable functions to the app.
 * - Allow add-ons to do HTTP only via an explicit allowlist (domain-based).
 * - Disallow anything that could access wallet secrets directly.
 */

export type AddonId = string;

export type AddonPermission =
  | {
      kind: 'http';
      /**
       * Domains the addon wants to call (no wildcards).
       * Example: ["api.example.com", "myservice.io"]
       */
      domains: string[];
    }
  | {
      kind: 'none';
    };

/**
 * A minimal “contract function” descriptor the UI can display.
 * Actual execution bindings can be added later.
 */
export interface AddonContractFunction {
  id: string; // stable within the addon
  name: string; // UI label
  description?: string;
  /**
   * Optional: If you want to group functions in the UI later.
   */
  group?: string;
  /**
   * Optional hint to the runner.
   * Examples: "send", "sign", "datasig", "checkdatasig"
   */
  intent?: string;
}

export interface AddonAppDefinition {
  id: string; // stable within addon
  name: string; // UI label
  description?: string;
  iconUri?: string | null;

  /**
   * v1 hardening: data-only apps.
   * The host renders a built-in generic UI based on this.
   */
  kind: 'declarative';

  /**
   * Optional: app-specific config blob (constraints, defaults, etc.)
   * Keep as unknown for v1 so we can evolve without breaking addons.
   */
  config?: unknown;
}

export interface ResolvedAddonAppDefinition extends AddonAppDefinition {
  addonId: AddonId;
  fullId: string; // `${addonId}:${id}`
}

export interface AddonContractDefinition {
  id: string; // stable within addon
  name: string;
  description?: string;

  /**
   * CashScript artifact JSON for the contract.
   * v1: inline only (no remote fetch).
   */
  cashscriptArtifact: unknown;

  /**
   * Functions this addon exposes for this contract.
   */
  functions: AddonContractFunction[];
}

/**
 * Resolved contract definition returned by the registry.
 * This avoids id collisions across multiple addons.
 */
export interface ResolvedAddonContractDefinition
  extends AddonContractDefinition {
  addonId: AddonId;
  /**
   * Fully-qualified id (unique across all addons)
   * Example: "optn.builtin.demo:p2pkh-demo"
   */
  fullId: string;
}

export interface AddonManifest {
  /**
   * Optional: bump this if you change manifest shape later.
   * Keep as number so we can evolve safely.
   */
  schemaVersion?: 1;

  id: AddonId;
  name: string;
  version: string;
  author?: string;
  description?: string;

  /**
   * Permissions requested by the addon.
   * v1: only `http` (restricted by global allowlist).
   */
  permissions: AddonPermission[];

  /**
   * Contracts that the addon adds to the app.
   */
  contracts: AddonContractDefinition[];

  /**
   * Optional metadata for UI lists.
   */
  iconUri?: string | null;

  /**
   * Marketplace lifecycle (future):
   * For builtins this can be omitted.
   */
  enabledByDefault?: boolean;

  /**
   * Optional apps exposed by the addon (data-only).
   */
  apps?: AddonAppDefinition[];
}
