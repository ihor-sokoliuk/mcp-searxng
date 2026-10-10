/* eslint-disable security/detect-non-literal-fs-filename -- paths belong to isolated temporary build fixtures and this repository's fixed inputs */
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestResults, printTestSummary, TestResult, testFunction } from '../helpers/test-utils.js';

const sourceRoot = fileURLToPath(new URL('../../', import.meta.url));
const helperName = 'make-dist-executable.mjs';

function fixture(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'mcp-build-tooling-'));
  try {
    mkdirSync(path.join(root, 'scripts'));
    copyFileSync(path.join(sourceRoot, 'scripts', helperName), path.join(root, 'scripts', helperName));
    return root;
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function runHelper(root: string) {
  return spawnSync(process.execPath, [path.join(root, 'scripts', helperName)], {
    cwd: tmpdir(), encoding: 'utf8', windowsHide: true, timeout: 10000,
  });
}

export async function runTests(): Promise<TestResult> {
  const results = createTestResults();
  await testFunction('build helper touches only top-level JavaScript and preserves other permissions', () => {
    const root = fixture();
    try {
      const dist = path.join(root, 'dist');
      mkdirSync(path.join(dist, 'nested.js'), { recursive: true });
      const files = [
        { name: 'cli.js', mode: 0o640, executable: true },
        { name: 'index.js', mode: 0o604, executable: true },
        { name: 'types.d.ts', mode: 0o640, executable: false },
        { name: 'nested.js/untouched.js', mode: 0o600, executable: false },
      ];
      for (const file of files) {
        writeFileSync(path.join(dist, file.name), 'original content');
        chmodSync(path.join(dist, file.name), file.mode);
      }
      const before = files.map(file => statSync(path.join(dist, file.name)).mode & 0o7777);
      const result = runHelper(root);
      assert.equal(result.status, 0, result.stderr);
      for (const [index, file] of files.entries()) {
        const expected = process.platform !== 'win32' && file.executable ? before[index] | 0o111 : before[index];
        assert.equal(statSync(path.join(dist, file.name)).mode & 0o7777, expected);
        assert.equal(readFileSync(path.join(dist, file.name), 'utf8'), 'original content');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, results);

  await testFunction('missing, empty, and non-directory dist fail visibly on every platform', () => {
    for (const kind of ['missing', 'empty', 'file']) {
      const root = fixture();
      try {
        const dist = path.join(root, 'dist');
        if (kind === 'empty') {
          mkdirSync(dist);
          writeFileSync(path.join(dist, 'types.d.ts'), 'not JavaScript');
        }
        if (kind === 'file') writeFileSync(dist, 'not a directory');
        const result = runHelper(root);
        assert.equal(result.error, undefined);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /dist/);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  }, results);

  await testFunction('the npm build fails when successful TypeScript emits no JavaScript', () => {
    const root = fixture();
    const modules = path.join(root, 'node_modules');
    try {
      const pkg = JSON.parse(readFileSync(path.join(sourceRoot, 'package.json'), 'utf8'));
      writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'build-fixture', private: true, scripts: { build: pkg.scripts.build } }));
      writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { declaration: true, emitDeclarationOnly: true, outDir: 'dist', types: [] }, files: ['index.ts'] }));
      writeFileSync(path.join(root, 'index.ts'), 'export const value = 1;');
      symlinkSync(path.join(sourceRoot, 'node_modules'), modules, process.platform === 'win32' ? 'junction' : 'dir');
      assert.ok(process.env.npm_execpath, 'Run this suite through the npm test runner');
      const result = spawnSync(process.execPath, [process.env.npm_execpath, 'run', 'build'], {
        cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30000,
      });
      assert.equal(result.error, undefined);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /No top-level JavaScript files/);
      assert.equal(readFileSync(path.join(root, 'dist', 'index.d.ts'), 'utf8').trim(), 'export declare const value = 1;');
    } finally {
      try { unlinkSync(modules); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      rmSync(root, { recursive: true, force: true });
    }
  }, results);
  printTestSummary(results, 'Build Tooling');
  return results;
}
