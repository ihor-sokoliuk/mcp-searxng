#!/usr/bin/env tsx

import { fileURLToPath } from 'node:url';
import path from 'node:path';

console.log('import.meta.url:', import.meta.url);
console.log('process.argv[1]:', process.argv[1]);
console.log('fileURLToPath(import.meta.url):', fileURLToPath(import.meta.url));
console.log('path.resolve(process.argv[1]):', path.resolve(process.argv[1]));
console.log('Match (fileURLToPath):', fileURLToPath(import.meta.url) === process.argv[1]);
console.log('Match (path.resolve):', fileURLToPath(import.meta.url) === path.resolve(process.argv[1]));
console.log('Done');
process.exit(0);
