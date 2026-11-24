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
        'service.env.production', 'nested/deep/api.env.staging',
        'nested/deep/.env.example', 'nested/deep/service.env.local',
    ];
    const publicFiles = [
        'package.json', 'src/index.ts', '.env.e2e.example',
        'docs/examples/search-stack/.env.example',
    ];
    for (const file of [...privateFiles, ...publicFiles]) {
        const target = join(context, file);
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixed fixture name inside the temporary context.
        mkdirSync(dirname(target), { recursive: true });
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixed fixture name inside the temporary context.
        writeFileSync(target, 'synthetic fixture');
    }
    copyFileSync(new URL('../.dockerignore', import.meta.url), join(context, '.dockerignore'));
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixed fixture name inside the temporary context.
    writeFileSync(join(context, 'Dockerfile'), 'FROM scratch\nCOPY . /app/\n');
    execFileSync('docker', ['buildx', 'build', '--output', 'type=local,dest=../output', '.'], {
        cwd: context, stdio: 'inherit',
    });
    for (const file of privateFiles) {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- Inspect the exported synthetic fixture only.
        assert.equal(existsSync(join(output, 'app', file)), false, file);
    }
    for (const file of publicFiles) {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- Inspect the exported synthetic fixture only.
        assert.equal(readFileSync(join(output, 'app', file), 'utf8'), 'synthetic fixture', file);
    }
} finally {
    rmSync(sandbox, { recursive: true, force: true });
}
