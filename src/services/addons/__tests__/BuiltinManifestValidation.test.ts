import { describe, expect, it } from 'vitest';
import { BUILTIN_ADDONS } from '../../../addons/builtin';
import { validateAddonPermissions } from '../../AddonsAllowlist';
import { validateAddonManifestAgainstSchema } from '../AddonManifestSchema';

describe('Builtin addon manifest validation', () => {
  it('passes schema and permission checks', () => {
    const errors: string[] = [];

    for (const manifest of BUILTIN_ADDONS) {
      const schemaErrors = validateAddonManifestAgainstSchema(manifest);
      if (schemaErrors.length) {
        errors.push(`[${manifest.id}] ${schemaErrors.join('; ')}`);
        continue;
      }

      try {
        validateAddonPermissions(manifest);
      } catch (e: unknown) {
        errors.push(
          `[${manifest.id}] ${e instanceof Error ? e.message : String(e)}`
        );
      }
    }

    expect(errors).toEqual([]);
  });
});
