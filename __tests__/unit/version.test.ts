#!/usr/bin/env tsx

/**
 * Unit Tests: version.ts
 *
 * Tests for the packageVersion constant in the dedicated version module.
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { packageVersion } from '../../src/version.js';
import { testFunction, createTestResults, printTestSummary, TestResult } from '../helpers/test-utils.js';

const results = createTestResults();

interface ReleaseVersionSurfaces {
  packageJson: string;
  packageLock: string;
  sourceModule: string;
  registryManifest: string;
  registryPackages: string[];
}

function asObject(value: unknown, description: string): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), `${description} must be an object`);
  return value;
}

function requiredString(object: Record<string, unknown>, field: string, description: string): string {
  const value = object[field];
  assert.equal(typeof value, 'string', `${description} must be a string`);
  return value;
}

function isAsciiDigit(character: string): boolean {
  return character >= '0' && character <= '9';
}

function isIdentifierCharacter(character: string): boolean {
  return isAsciiDigit(character)
    || (character >= 'A' && character <= 'Z')
    || (character >= 'a' && character <= 'z')
    || character === '-';
}

function isNumericIdentifier(value: string): boolean {
  return value.length > 0
    && !(value.length > 1 && value[0] === '0')
    && [...value].every(isAsciiDigit);
}

function isPrereleaseIdentifier(value: string): boolean {
  return isNumericIdentifier(value)
    || (value.length > 0 && [...value].every(isIdentifierCharacter) && [...value].some((character) => !isAsciiDigit(character)));
}

function isExactSemver(version: string): boolean {
  const buildSeparator = version.indexOf('+');
  const hasBuild = buildSeparator !== -1;
  const coreAndPrerelease = hasBuild ? version.slice(0, buildSeparator) : version;
  const build = hasBuild ? version.slice(buildSeparator + 1) : undefined;

  if (hasBuild && (version.indexOf('+', buildSeparator + 1) !== -1 || !build || !build.split('.').every(
    (identifier) => identifier.length > 0 && [...identifier].every(isIdentifierCharacter),
  ))) {
    return false;
  }

  const prereleaseSeparator = coreAndPrerelease.indexOf('-');
  const core = prereleaseSeparator === -1 ? coreAndPrerelease : coreAndPrerelease.slice(0, prereleaseSeparator);
  const prerelease = prereleaseSeparator === -1 ? undefined : coreAndPrerelease.slice(prereleaseSeparator + 1);

  return core.split('.').length === 3
    && core.split('.').every(isNumericIdentifier)
    && (prerelease === undefined || prerelease.split('.').every(isPrereleaseIdentifier));
}

function assertReleaseVersionContract(surfaces: ReleaseVersionSurfaces): void {
  const versions = [
    ['package.json', surfaces.packageJson],
    ['package-lock.json', surfaces.packageLock],
    ['src/version.ts', surfaces.sourceModule],
    ['.mcp/server.json', surfaces.registryManifest],
    ...surfaces.registryPackages.map((version, index) => [`.mcp/server.json packages[${index}]`, version] as const),
  ];

  for (const [surface, version] of versions) {
    assert.ok(isExactSemver(version), `${surface} version must be valid exact SemVer`);
    assert.equal(version, surfaces.packageJson, `${surface} version must match package.json`);
  }
}

function consistentReleaseVersionSurfaces(version: string): ReleaseVersionSurfaces {
  return {
    packageJson: version,
    packageLock: version,
    sourceModule: version,
    registryManifest: version,
    registryPackages: [version],
  };
}

export async function runTests(): Promise<TestResult> {
  console.log('🧪 Testing: version.ts\n');

  await testFunction('release version surfaces use one exact semver version', () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is a compile-time constant, not user input
    const pkgJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf-8'));
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is a compile-time constant, not user input
    const packageLock = JSON.parse(readFileSync(new URL('../../package-lock.json', import.meta.url), 'utf-8'));
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is a compile-time constant, not user input
    const manifest = JSON.parse(readFileSync(new URL('../../.mcp/server.json', import.meta.url), 'utf-8'));
    const manifestObject = asObject(manifest, '.mcp/server.json');
    const registryPackages = manifestObject.packages;
    assert.ok(Array.isArray(registryPackages), '.mcp/server.json packages must be an array');

    assertReleaseVersionContract({
      packageJson: requiredString(asObject(pkgJson, 'package.json'), 'version', 'package.json version'),
      packageLock: requiredString(asObject(packageLock, 'package-lock.json'), 'version', 'package-lock.json version'),
      sourceModule: packageVersion,
      registryManifest: requiredString(manifestObject, 'version', '.mcp/server.json version'),
      registryPackages: registryPackages.map((entry, index) => requiredString(
        asObject(entry, `.mcp/server.json packages[${index}]`),
        'version',
        `.mcp/server.json packages[${index}] version`,
      )),
    });
  }, results);

  await testFunction('release version contract accepts arbitrary consistent exact semver', () => {
    for (const version of ['2.0.0', '2.0.1', '2.0.1-rc.1+build.7']) {
      assertReleaseVersionContract(consistentReleaseVersionSurfaces(version));
    }
  }, results);

  await testFunction('release version contract rejects malformed versions and surface drift', () => {
    for (const version of ['02.0.1', '2.0.1-01', '2.0.1-', '2.0.1+']) {
      assert.throws(
        () => assertReleaseVersionContract(consistentReleaseVersionSurfaces(version)),
        /valid exact SemVer/,
      );
    }
    assert.throws(
      () => assertReleaseVersionContract({
        ...consistentReleaseVersionSurfaces('2.0.1'),
        packageLock: '2.0.0',
      }),
      /package-lock\.json version must match package\.json/,
    );
  }, results);

  await testFunction('MCP registry treats credential-bearing SEARXNG_URL as secret', () => {
    const manifest = JSON.parse(
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is a compile-time constant
      readFileSync(new URL('../../.mcp/server.json', import.meta.url), 'utf-8'),
    );
    const variables = manifest.packages
      .flatMap((entry: { environmentVariables?: unknown[] }) => entry.environmentVariables ?? []);
    for (const name of ['SEARXNG_URL', 'AUTH_USERNAME', 'AUTH_PASSWORD']) {
      const variable = variables.find((entry: { name?: string }) => entry.name === name);
      assert.ok(variable, `${name} must be declared in the MCP registry manifest`);
      assert.equal(variable.isSecret, true, `${name} must be marked secret`);
    }
  }, results);

  printTestSummary(results, 'Version Module');
  return results;
}

runTests();
