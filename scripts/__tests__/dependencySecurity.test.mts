import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

it('compiles closing AST nodes without writing to stdout', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--eval',
      String.raw`
        const assert = require('node:assert/strict');
        const braces = require('braces');
        const closing = { type: 'close', isClose: true, value: '}' };
        const tree = { type: 'root', nodes: [{ type: 'text', value: 'literal' }, closing] };
        assert.equal(braces.compile(closing), '}');
        assert.equal(braces.compile(tree), 'literal}');
        assert.equal(braces.compile(tree, { escapeInvalid: true }), 'literal\\}');
      `,
    ],
    { cwd: repoRoot, encoding: 'utf8', timeout: 10_000 }
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe('');
});

it('retains the upstream input-length and imbalanced-brace resource bounds', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--max-old-space-size=64',
      '--eval',
      `
        const assert = require('node:assert/strict');
        const braces = require('braces');
        // GHSA-grv7-fg5c-xmjg: malformed patterns must not amplify heap usage.
        // Keep this separate from the newer recursive-walker regression below.
        const tooLong = '{' + 'a'.repeat(10000);
        const lengthBounded = error => error instanceof SyntaxError && /exceeds max characters/.test(error.message);
        for (const operation of [braces, braces.create, braces.parse, braces.compile, braces.expand, braces.stringify]) {
          assert.throws(() => operation(tooLong), lengthBounded);
          assert.throws(() => operation(tooLong, { maxLength: Infinity }), lengthBounded);
        }
        for (const pattern of [
          '{'.repeat(99) + 'a'.repeat(9803) + '}'.repeat(98),
          '{a,'.repeat(99)
        ]) {
          assert.equal(braces.compile(pattern), pattern);
          assert.equal(braces.stringify(pattern), pattern);
          assert.deepEqual(braces.expand(pattern), [pattern]);
        }
      `,
    ],
    { cwd: repoRoot, encoding: 'utf8', timeout: 10_000 }
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
});

it('bounds brace patterns and caller-supplied AST recursion before stack exhaustion', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--stack_size=512',
      '--eval',
      `
        const assert = require('node:assert/strict');
        const braces = require('braces');
        const bounded = error => error instanceof SyntaxError && /nesting depth exceeds/.test(error.message);
        for (const [open, close] of [['{', '}'], ['(', ')'], ['{(', ')}']]) {
          const pattern = open.repeat(2000) + 'a,b' + close.repeat(2000);
          for (const operation of [braces, braces.create, braces.parse, braces.compile, braces.expand, braces.stringify]) {
            assert.throws(() => operation(pattern), bounded);
          }
        }
        const ast = depth => {
          let tree = { type: 'root', nodes: [] };
          for (let i = 0; i < depth; i++) tree = { type: 'root', nodes: [tree] };
          return tree;
        };
        for (const method of ['compile', 'expand', 'stringify']) {
          assert.deepEqual(braces[method](ast(100)), method === 'expand' ? [] : '');
          assert.throws(() => braces[method](ast(101)), bounded);
          assert.throws(() => braces[method](ast(4000)), bounded);
          const cyclic = { type: 'root', nodes: [] };
          cyclic.nodes.push(cyclic);
          assert.throws(() => braces[method](cyclic), bounded);
        }
      `,
    ],
    { cwd: repoRoot, encoding: 'utf8', timeout: 10_000 }
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
});

it('preserves ordinary brace syntax and installs the bounded implementation for glob consumers', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--eval',
      String.raw`
        const assert = require('node:assert/strict');
        const { createRequire } = require('node:module');
        const braces = require('braces');
        assert.equal(require('braces/package.json').name, '@optn/build-braces');
        assert.equal(braces.compile('app/{reading,writing}/**/*.{js,jsx}'), 'app/(reading|writing)/**/*.(js|jsx)');
        assert.deepEqual(braces.expand('page-{1..3}.js'), ['page-1.js', 'page-2.js', 'page-3.js']);
        assert.deepEqual(braces.expand('a\\{b,c\\}'), ['a{b,c}']);
        assert.deepEqual(braces.expand('a{b,{c,{d,e}}}f'), ['abf', 'acf', 'adf', 'aef']);
        assert.equal(braces.compile(braces.parse('a/{b,c}/d')), 'a/(b|c)/d');
        const nested = '{'.repeat(99) + 'x' + '}'.repeat(99);
        assert.equal(braces.stringify(nested), nested);
        assert.deepEqual(braces.expand(nested), [nested]);
        for (const consumer of ['micromatch', 'fast-glob', 'tailwindcss', 'patch-package']) {
          const consumerRequire = createRequire(require.resolve(consumer));
          assert.equal(consumerRequire('braces/package.json').name, '@optn/build-braces', consumer);
        }
        const micromatch = require('micromatch');
        assert.deepEqual(micromatch(['src/a.ts', 'src/b.tsx', 'src/c.rs'], 'src/*.{ts,tsx}'), ['src/a.ts', 'src/b.tsx']);
        const files = require('fast-glob').sync('vendor/braces/{index,lib/utils}.js').sort();
        assert.deepEqual(files, ['vendor/braces/index.js', 'vendor/braces/lib/utils.js']);
      `,
    ],
    { cwd: repoRoot, encoding: 'utf8', timeout: 10_000 }
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
});

it('bounds indexed source-map offsets before mapping work', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
        import assert from 'node:assert/strict';
        import sourceMap from 'source-map-js';
        const leaf = { version: 3, sources: ['fixture.ts'], names: [], mappings: 'AAAA' };
        const section = (line, map = leaf) => ({
          version: 3, sections: [{ offset: { line, column: 0 }, map }]
        });
        const valid = new sourceMap.SourceMapConsumer(section(2));
        assert.deepEqual(valid.originalPositionFor({ line: 3, column: 1 }), {
          source: 'fixture.ts', line: 1, column: 0, name: null
        });
        for (const line of [-1, 0.5, Infinity, 1e7 + 1]) {
          assert.throws(() => new sourceMap.SourceMapConsumer(section(line)));
        }
        assert.throws(() => new sourceMap.SourceMapConsumer(section(6e6, section(6e6))));
      `,
    ],
    { cwd: repoRoot, encoding: 'utf8', timeout: 10_000 }
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
});

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
