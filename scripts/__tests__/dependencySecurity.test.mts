import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

it('keeps inherited HTTP methods out of Axios requests', () => {
  // Isolate the advisory's prototype pollution from the test runner. No I/O.
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
        import assert from 'node:assert/strict';
        import axios from 'axios';
        Object.prototype.method = 'delete';
        try {
          const response = await axios.request({
            url: 'https://wallet.invalid/',
            adapter: async config => ({ data: config.method, status: 200,
              statusText: 'OK', headers: {}, config })
          });
          assert.equal(response.data, 'get');
        } finally {
          delete Object.prototype.method;
        }
      `,
    ],
    { cwd: repoRoot, encoding: 'utf8', timeout: 10_000 }
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
});

it('escapes every script-closing tag in serialized function bodies', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
        import assert from 'node:assert/strict';
        import serialize from 'serialize-javascript';
        // Static regression input; the resulting function is never called.
        const fn = new Function("return function(x){return x</script=+/ + '</script><b>markup</b>'}")();
        assert.equal(serialize({ fn }).toLowerCase().includes('</script>'), false);
      `,
    ],
    { cwd: repoRoot, encoding: 'utf8', timeout: 10_000 }
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
});
