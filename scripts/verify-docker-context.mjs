// Run with node scripts/verify-docker-context.mjs on a host with Docker Buildx.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const sandbox = mkdtempSync(join(tmpdir(), 'mcp-docker-context-'));
try {
    const context = join(sandbox, 'context');
    const output = join(sandbox, 'output');
    const privateFiles = [
        '.env', '.env.e2e', 'service.env.local', 'service.env',
        'docs/examples/search-stack/.env', 'nested/deep/.env.production',
        'nested/deep/.env.example', 'nested/deep/service.env.local',
    ];
    const publicFiles = [
        'package.json', 'src/index.ts', '.env.e2e.example',
        'docs/examples/search-stack/.env.example',
    ];
    /* eslint-disable security/detect-non-literal-fs-filename -- All paths below use fixed fixture names under the unique temporary directory. */
    for (const file of [...privateFiles, ...publicFiles]) {
        const target = join(context, file);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, 'synthetic fixture');
    }
    copyFileSync(new URL('../.dockerignore', import.meta.url), join(context, '.dockerignore'));
    writeFileSync(join(context, 'Dockerfile'), 'FROM scratch\nCOPY . /app/\n');
    execFileSync('docker', ['buildx', 'build', '--output', 'type=local,dest=../output', '.'], {
        cwd: context, stdio: 'inherit',
    });
    for (const file of privateFiles) assert.equal(existsSync(join(output, 'app', file)), false, file);
    for (const file of publicFiles) assert.equal(readFileSync(join(output, 'app', file), 'utf8'), 'synthetic fixture', file);
    /* eslint-enable security/detect-non-literal-fs-filename */
} finally {
    rmSync(sandbox, { recursive: true, force: true });
}
