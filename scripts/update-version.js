#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

// Setup dirname equivalent for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Use createRequire to load JSON files
const require = createRequire(import.meta.url);
const packageJson = require('../package.json');
const version = packageJson.version;

// Path to version.ts (packageVersion was moved here from index.ts)
const versionPath = path.join(__dirname, '..', 'src', 'version.ts');

// Read the file
let content = fs.readFileSync(versionPath, 'utf8');

// Define a static version string to replace
const staticVersionRegex = /const packageVersion = "([\d\.]+|unknown)";/;

// Replace with updated version from package.json
if (staticVersionRegex.test(content)) {
  content = content.replace(staticVersionRegex, `const packageVersion = "${version}";`);

  // Write the updated content
  fs.writeFileSync(versionPath, content);

  console.log(`Updated version in version.ts to ${version}`);
} else {
  console.error('Could not find static version declaration in version.ts');
  process.exit(1);
}

// Update version in .mcp/server.json
const serverJsonPath = path.join(__dirname, '..', '.mcp', 'server.json');
const serverJson = require(serverJsonPath);
serverJson.version = version;
serverJson.packages = serverJson.packages.map(pkg => ({ ...pkg, version }));
fs.writeFileSync(serverJsonPath, JSON.stringify(serverJson, null, 2) + '\n');
console.log(`Updated version in .mcp/server.json to ${version}`);

// Output the tag name to be used in the git command
console.log(`v${version}`);