import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function checkBraces(script: string) {
  // A vulnerable parser must fail this test without hanging the test runner.
  const result = spawnSync(
    process.execPath,
    [
      '--eval',
      `const assert = require('node:assert/strict');
       const braces = require('node:module').createRequire(require.resolve('micromatch'))('braces');
       ${script}`,
    ],
    { cwd: repoRoot, encoding: 'utf8', timeout: 10_000 }
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
}

it('rejects excessive brace and parenthesis nesting at every string entry point', () => {
  checkBraces(`
    const processors = [braces, ...['create', 'parse', 'compile', 'expand', 'stringify']
      .map(name => braces[name])];
    for (const [open, close] of [['{', '}'], ['(', ')'], ['({', '})']]) {
      const input = open.repeat(2000) + 'a,b' + close.repeat(2000);
      assert.ok(input.length < 10000);
      for (const process of processors) {
        // Match the intentional rejection, not a V8 call-stack overflow.
        for (const maxDepth of [undefined, 10000, Infinity, NaN]) {
          assert.throws(() => process(input, { maxDepth }),
            error => error instanceof SyntaxError && /exceeds max depth/.test(error.message));
        }
      }
    }
    const nested = n => '{'.repeat(n) + 'a,b' + '}'.repeat(n);
    assert.doesNotThrow(() => braces.parse(nested(100)));
    assert.throws(() => braces.parse(nested(101)), /exceeds max depth/);
    assert.throws(() => braces.parse(nested(2), { maxDepth: 1.5 }), /exceeds max depth/);
    let reads = 0;
    assert.throws(() => braces.parse(nested(2), {
      get maxDepth() { return ++reads === 1 ? 1 : NaN; }
    }), /exceeds max depth/);
    assert.equal(reads, 1);
    assert.throws(() => braces.parse('x'.repeat(10001), { maxLength: NaN }), /maxLength/);
  `);
});

it('bounds direct AST traversal and rejects cyclic expansion parents', () => {
  checkBraces(`
    const tree = depth => {
      let node = { type: 'text', value: 'a' };
      for (let i = 0; i < depth; i++) node = { type: 'brace', nodes: [node] };
      return { type: 'root', nodes: [node] };
    };
    for (const name of ['compile', 'expand', 'stringify']) {
      assert.throws(() => braces[name](tree(2000), { maxDepth: Infinity }),
        error => error instanceof RangeError && /exceeds max depth/.test(error.message));
      const cyclic = { type: 'root', nodes: [] };
      cyclic.nodes.push(cyclic);
      assert.throws(() => braces[name](cyclic), /exceeds max depth/);
    }
    const cyclicParent = { type: 'paren', nodes: [{ type: 'text', value: 'a' }] };
    cyclicParent.parent = cyclicParent;
    assert.throws(() => braces.expand(cyclicParent), /parent chain contains a cycle/);
  `);
});

it('keeps normal glob behavior and guards the copies used by build tools', () => {
  checkBraces(`
    const { createRequire } = require('node:module');
    const micromatch = require('micromatch');
    assert.deepEqual(braces.expand('src/{one,two}/{01..03..2}.ts'),
      ['src/one/01.ts', 'src/one/03.ts', 'src/two/01.ts', 'src/two/03.ts']);
    assert.equal(braces.stringify(braces.parse('foo/({a,b})')), 'foo/({a,b})');
    assert.deepEqual(braces.expand('foo/({a,b})'), ['foo/(a)', 'foo/(b)']);
    assert.deepEqual(micromatch(['src/a.ts', 'src/b.tsx', 'src/c.css', 'lib/d.ts'],
      'src/**/*.{ts,tsx}'), ['src/a.ts', 'src/b.tsx']);
    const deep = '{'.repeat(101) + 'a,b' + '}'.repeat(101);
    assert.throws(() => micromatch.braceExpand(deep), /exceeds max depth/);
    const consumers = [createRequire(require.resolve('micromatch'))];
    const tailwind = createRequire(require.resolve('tailwindcss'));
    consumers.push(createRequire(tailwind.resolve('chokidar')));
    for (const consumer of consumers) {
      assert.throws(() => consumer('braces').expand(deep), /exceeds max depth/);
    }
    // Check every locked copy, so a nested vulnerable installation cannot hide
    // behind one fixed consumer. Behavioral tests above prove the fix.
    const lock = require('./package-lock.json');
    const entries = Object.entries(lock.packages)
      .filter(([path]) => path === 'node_modules/braces' || path.endsWith('/node_modules/braces'));
    assert.ok(entries.length > 0);
    for (const [path] of entries) {
      assert.throws(() => require('./' + path).expand(deep), /exceeds max depth/);
    }
  `);
});
