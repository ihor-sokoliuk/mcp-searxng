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

// Path to index.ts
const indexPath = path.join(__dirname, '..', 'src', 'index.ts');

// Read the file
let content = fs.readFileSync(indexPath, 'utf8');

// Define a static version string to replace
const staticVersionRegex = /const packageVersion = "([\d\.]+|unknown)";/;

// Replace with updated version from package.json
if (staticVersionRegex.test(content)) {
  content = content.replace(staticVersionRegex, `const packageVersion = "${version}";`);
  
  // Write the updated content
  fs.writeFileSync(indexPath, content);
  
  console.log(`Updated version in index.ts to ${version}`);
  
  // Output the tag name to be used in the git command
  console.log(`v${version}`);
} else {
  console.error('Could not find static version declaration in index.ts');
  process.exit(1);
}