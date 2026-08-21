const REQUIRED_SDK_RUNTIME = new Map([
  ['@modelcontextprotocol/core', '2.0.0'],
  ['@modelcontextprotocol/node', '2.0.0'],
  ['@modelcontextprotocol/server', '2.0.0'],
  ['zod', '4.2.0'],
]);
const EXPECTED_TOOLS = Object.freeze([
  'searxng_web_search',
  'web_url_read',
  'searxng_search_suggestions',
  'searxng_instance_info',
]);

export function fail(category, message) {
  throw new Error(`${category}: ${message}`);
}

function parseStableSemver(value) {
  if (typeof value !== 'string') {
    fail('unsafe_dependency_tree', 'SDK runtime version is missing');
  }
  if (value.length > 64) {
    fail('unsafe_dependency_tree', 'SDK runtime version is invalid');
  }
  // eslint-disable-next-line security/detect-unsafe-regex -- input is capped at 64 characters above
  const match = /^(\d+)\.(\d+)\.(\d+)(?:\+[0-9A-Za-z.-]+)?$/.exec(value);
  if (!match) {
    fail('unsafe_dependency_tree', `SDK runtime version is invalid: ${value}`);
  }
  return match.slice(1, 4).map(Number);
}

function requireDependencyNode(node, message) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    fail('unsafe_dependency_tree', message);
  }
  return node;
}

function assertNoNpmProblems(node) {
  if (Array.isArray(node.problems) && node.problems.length > 0) {
    fail('unsafe_dependency_tree', `npm problems: ${node.problems.join('; ')}`);
  }
}

function recordSdkRuntimeVersion(name, dependency, versions) {
  if (dependency.invalid) {
    fail('unsafe_dependency_tree', `${name} is marked invalid`);
  }
  if (dependency.extraneous) {
    fail('unsafe_dependency_tree', `${name} is marked extraneous`);
  }
  parseStableSemver(dependency.version);
  const requiredVersion = REQUIRED_SDK_RUNTIME.get(name);
  if (dependency.version !== requiredVersion) {
    fail(
      'unsafe_dependency_tree',
      `${name} version ${dependency.version} must be ${requiredVersion}`,
    );
  }
  versions.push({ name, version: dependency.version });
}

function visitDependencyNode(node, versions) {
  const dependencyNode = requireDependencyNode(
    node,
    'dependency node is malformed',
  );
  assertNoNpmProblems(dependencyNode);
  const { dependencies } = dependencyNode;
  if (dependencies === undefined) return;
  requireDependencyNode(dependencies, 'dependencies map is malformed');
  for (const [name, dependencyValue] of Object.entries(dependencies)) {
    const dependency = requireDependencyNode(
      dependencyValue,
      `dependency ${name} is malformed`,
    );
    if (REQUIRED_SDK_RUNTIME.has(name)) {
      recordSdkRuntimeVersion(name, dependency, versions);
    }
    visitDependencyNode(dependency, versions);
  }
}

export function assertSafeDependencyTree(tree) {
  requireDependencyNode(tree, 'npm ls output is not an object');
  const versions = [];
  visitDependencyNode(tree, versions);
  const uniqueVersions = new Map(versions.map((entry) => [entry.name, entry]));
  const found = new Set(uniqueVersions.keys());
  const missing = [...REQUIRED_SDK_RUNTIME.keys()].filter((name) => !found.has(name));
  if (missing.length > 0) {
    fail('unsafe_dependency_tree', `required SDK runtime dependency is missing: ${missing.join(', ')}`);
  }
  return [...uniqueVersions.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export function assertZeroProductionAudit(report) {
  const vulnerabilities = report?.metadata?.vulnerabilities;
  if (!vulnerabilities || typeof vulnerabilities !== 'object') {
    fail('audit_gate', 'vulnerability metadata is missing');
  }
  if (
    typeof vulnerabilities.total !== 'number'
    || !Number.isFinite(vulnerabilities.total)
  ) {
    fail('audit_gate', 'vulnerability total must be numeric');
  }
  if (vulnerabilities.total !== 0) {
    fail(
      'audit_gate',
      `production audit reported ${vulnerabilities.total} vulnerabilities`,
    );
  }
  return vulnerabilities;
}

function requirePackFiles(packReport) {
  if (!packReport || typeof packReport !== 'object') {
    fail('artifact_metadata', 'npm pack report is missing');
  }
  if (!Array.isArray(packReport.files)) {
    fail('artifact_metadata', 'npm pack file list is missing');
  }
  return packReport.files;
}

function assertPackFilesSafe(files) {
  for (const file of files) {
    if (!file || typeof file !== 'object' || Array.isArray(file)) {
      fail('artifact_metadata', 'npm pack file entry is malformed');
    }
    const { path: filePath } = file;
    if (
      typeof filePath === 'string'
      && filePath.toLowerCase() === 'npm-shrinkwrap.json'
    ) {
      fail('artifact_metadata', 'npm shrinkwrap is forbidden');
    }
  }
}

function assertPdfWorkerIncluded(files) {
  if (!files.some((file) => file?.path === 'dist/pdf-worker.js')) {
    fail('artifact_metadata', 'dist/pdf-worker.js is missing from the packed artifact');
  }
}

function assertInstalledPackageSafe(installedPackage) {
  if (!installedPackage || typeof installedPackage !== 'object') {
    fail('artifact_metadata', 'installed package manifest is missing');
  }
  if (installedPackage.main !== undefined) {
    fail('artifact_metadata', 'programmatic main entrypoint is forbidden');
  }
  if (
    !installedPackage.exports
    || typeof installedPackage.exports !== 'object'
    || Array.isArray(installedPackage.exports)
    || Object.keys(installedPackage.exports).length !== 0
  ) {
    fail('artifact_metadata', 'package exports must block programmatic imports');
  }
  if (installedPackage.dependencies?.['@modelcontextprotocol/sdk'] !== undefined) {
    fail('artifact_metadata', 'legacy monolithic SDK dependency is forbidden');
  }
}

export function assertArtifactMetadata(packReport, installedPackage) {
  const files = requirePackFiles(packReport);
  assertPackFilesSafe(files);
  assertInstalledPackageSafe(installedPackage);
  assertPdfWorkerIncluded(files);
  return true;
}

function collectJsonRpcResponses(stdout) {
  const responses = new Map();
  for (const line of String(stdout).split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const message = JSON.parse(line);
      if (message && typeof message === 'object' && message.id !== undefined) {
        responses.set(message.id, message);
      }
    } catch {
      // Diagnostic lines are intentionally ignored; only JSON-RPC IDs matter.
    }
  }
  return responses;
}

function requireSuccessfulResponse(responses, id, label) {
  const response = responses.get(id);
  if (!response) fail('mcp_smoke', `${label} response is missing`);
  if (response.error) fail('mcp_smoke', `${label} returned an error`);
  return response;
}

function assertInitializeResponse(responses) {
  const initialize = requireSuccessfulResponse(responses, 1, 'initialize');
  if (!initialize.result || typeof initialize.result !== 'object') {
    fail('mcp_smoke', 'initialize result is malformed');
  }
}

function requireExpectedTools(responses) {
  const toolsList = requireSuccessfulResponse(responses, 2, 'tools/list');
  if (!Array.isArray(toolsList.result?.tools)) {
    fail('mcp_smoke', 'tools/list tools result is malformed');
  }
  const toolNames = new Set(
    toolsList.result.tools.map((tool) => tool?.name).filter(Boolean),
  );
  const missingTools = EXPECTED_TOOLS.filter((name) => !toolNames.has(name));
  if (missingTools.length > 0) {
    fail('mcp_smoke', `expected tools are missing: ${missingTools.join(', ')}`);
  }
  return toolsList.result.tools;
}

export function assertMcpSmokeResponses(stdout) {
  const responses = collectJsonRpcResponses(stdout);
  assertInitializeResponse(responses);
  return requireExpectedTools(responses).length;
}

function isStepStart(line) {
  return typeof line === 'string' && line.startsWith('      - ');
}

function findStepBlock(lines, commandIndex) {
  let start = commandIndex;
  while (start >= 0 && !isStepStart(lines.at(start))) start -= 1;
  if (start < 0) fail('workflow_contract', 'command is not inside a step');
  let end = commandIndex + 1;
  while (end < lines.length && !isStepStart(lines.at(end))) end += 1;
  return lines.slice(start, end);
}

function isTopLevelJob(line) {
  return (
    typeof line === 'string'
    && line.startsWith('  ')
    && !line.startsWith('    ')
    && line.trimEnd().endsWith(':')
  );
}

function findPublishJob(lines) {
  const jobStart = lines.findIndex(
    (line) => line.trimEnd() === '  build-and-publish:',
  );
  if (jobStart < 0) {
    fail('workflow_contract', 'build-and-publish job is missing');
  }
  const nextJobOffset = lines
    .slice(jobStart + 1)
    .findIndex(isTopLevelJob);
  const jobEnd = nextJobOffset < 0
    ? lines.length
    : jobStart + 1 + nextJobOffset;
  return lines.slice(jobStart, jobEnd);
}

function findRunCommand(jobLines, command) {
  return jobLines.findIndex((line) => (
    line.trimStart().startsWith('run:')
    && line.includes(command)
  ));
}

function requireOrderedCommands(jobLines) {
  const indexes = [
    findRunCommand(jobLines, 'npm run test:coverage'),
    findRunCommand(jobLines, 'npm run build'),
    findRunCommand(jobLines, 'npm run verify:packed-consumer'),
    findRunCommand(jobLines, 'npm publish'),
  ];
  if (indexes.some((index) => index < 0)) {
    fail(
      'workflow_contract',
      'tests, build, verifier, and publish must share one job',
    );
  }
  const [testIndex, buildIndex, verifierIndex, publishIndex] = indexes;
  if (!(testIndex < buildIndex
    && buildIndex < verifierIndex
    && verifierIndex < publishIndex)) {
    fail(
      'workflow_contract',
      'tests and build must run before the verifier, which must precede publish',
    );
  }
  return { verifierIndex, publishIndex };
}

function assertFailClosed(jobLines, verifierIndex, publishIndex) {
  const normalizedJobLines = jobLines.map(normalizeGuardLine);
  if (normalizedJobLines.some((line) => line.startsWith('continue-on-error:'))) {
    fail('workflow_contract', 'continue-on-error is forbidden');
  }
  const verifierStep = findStepBlock(jobLines, verifierIndex);
  const publishStep = findStepBlock(jobLines, publishIndex);
  const publishCondition = publishStep
    .map(normalizeGuardLine)
    .find((line) => line.startsWith('if:'));
  if (publishCondition) {
    fail('workflow_contract', 'publish conditions are forbidden');
  }
  const verifierText = verifierStep.join('\n');
  const compactVerifierText = verifierText.replaceAll(/\s/g, '');
  if (compactVerifierText.includes('||true') || compactVerifierText.includes('set+e')) {
    fail('workflow_contract', 'verifier exit suppression is forbidden');
  }
  return { verifierStep, publishStep };
}

function normalizeGuardLine(line) {
  const commentIndex = line.indexOf('#');
  return (commentIndex < 0 ? line : line.slice(0, commentIndex)).trim();
}

function shellTokens(lines) {
  return lines
    .join(' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function requireExactPublishedArtifact(verifierStep, publishStep) {
  const verifierTokens = shellTokens(verifierStep);
  const outputIndex = verifierTokens.indexOf('--output');
  const artifact = verifierTokens.at(outputIndex + 1);
  if (outputIndex < 0 || !artifact) {
    fail('workflow_contract', 'verifier output artifact is missing');
  }
  const publishTokens = shellTokens(publishStep);
  const npmIndex = publishTokens.findIndex((token, index) => (
    token === 'npm' && publishTokens.at(index + 1) === 'publish'
  ));
  const isExactArtifact = (
    npmIndex >= 0
    && publishTokens.at(npmIndex + 1) === 'publish'
    && publishTokens.at(npmIndex + 2) === artifact
  );
  if (!isExactArtifact) {
    fail('workflow_contract', 'publish must use the exact verified artifact');
  }
}

export function assertPublishWorkflowContract(yamlText) {
  const jobLines = findPublishJob(String(yamlText).split(/\r?\n/));
  const { verifierIndex, publishIndex } = requireOrderedCommands(jobLines);
  const { verifierStep, publishStep } = assertFailClosed(
    jobLines,
    verifierIndex,
    publishIndex,
  );
  requireExactPublishedArtifact(verifierStep, publishStep);
  return true;
}
