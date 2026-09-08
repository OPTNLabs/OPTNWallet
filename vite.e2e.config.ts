import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  defineConfig,
  mergeConfig,
  type ConfigEnv,
  type UserConfig,
} from 'vite';

import baseConfig from './vite.config';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * E2E web assets intentionally load environment files from e2e/ only. This
 * keeps browser/emulator smoke builds deterministic and prevents a developer
 * machine's root .env from entering a test artifact.
 */
export default defineConfig(async (env: ConfigEnv): Promise<UserConfig> => {
  const baseConfigOrFn = baseConfig;
  const resolvedBase =
    typeof baseConfigOrFn === 'function'
      ? await (
          baseConfigOrFn as (
            configEnv: ConfigEnv
          ) => UserConfig | Promise<UserConfig>
        )(env)
      : baseConfigOrFn;

  return mergeConfig(resolvedBase, {
    envDir: resolve(__dirname, 'e2e'),
  });
});
