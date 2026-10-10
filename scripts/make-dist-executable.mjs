import { chmodSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = fileURLToPath(new URL('../dist/', import.meta.url));
// eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed build output directory relative to this script
const files = readdirSync(directory, { withFileTypes: true }).filter(file => file.isFile() && file.name.endsWith('.js'));
if (files.length === 0) throw new Error('No top-level JavaScript files found in dist');

if (process.platform !== 'win32') {
  for (const file of files) {
    const destination = path.join(directory, file.name);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- regular top-level JavaScript file discovered in the fixed build output directory
    const mode = statSync(destination).mode & 0o7777;
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- same discovered build output file; preserve existing permissions
    chmodSync(destination, mode | 0o111);
  }
}
