const PATCHED_NODE_SERVER = Object.freeze([2, 0, 5]);
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
    fail('unsafe_dependency_tree', 'adapter version is missing');
  }
  if (value.length > 64) {
    fail('unsafe_dependency_tree', 'adapter version is invalid');
  }
  // eslint-disable-next-line security/detect-unsafe-regex -- input is capped at 64 characters above
  const match = /^(\d+)\.(\d+)\.(\d+)(?:\+[0-9A-Za-z.-]+)?$/.exec(value);
  if (!match) {
    fail('unsafe_dependency_tree', `adapter version is invalid: ${value}`);
  }
  return match.slice(1, 4).map(Number);
}

function isAtLeastPatched(version) {
  const [major, minor, patch] = version;
  const [patchedMajor, patchedMinor, patchedPatch] = PATCHED_NODE_SERVER;
  if (major !== patchedMajor) return major > patchedMajor;
  if (minor !== patchedMinor) return minor > patchedMinor;
  return patch >= patchedPatch;
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

function recordAdapterVersion(dependency, versions) {
  if (dependency.invalid) {
    fail('unsafe_dependency_tree', 'adapter is marked invalid');
  }
  if (dependency.extraneous) {
    fail('unsafe_dependency_tree', 'adapter is marked extraneous');
  }
  const parsed = parseStableSemver(dependency.version);
  if (!isAtLeastPatched(parsed)) {
    fail(
      'unsafe_dependency_tree',
      `adapter version ${dependency.version} is below 2.0.5`,
    );
  }
  versions.push(dependency.version);
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
    if (name === '@hono/node-server') {
      recordAdapterVersion(dependency, versions);
    }
    visitDependencyNode(dependency, versions);
  }
}

export function assertSafeDependencyTree(tree) {
  requireDependencyNode(tree, 'npm ls output is not an object');
  const versions = [];
  visitDependencyNode(tree, versions);
  if (versions.length === 0) {
    fail('unsafe_dependency_tree', 'patched adapter dependency is missing');
  }
  return versions.sort((left, right) => left.localeCompare(right, undefined, {
    numeric: true,
  }));
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

function assertInstalledPackageSafe(installedPackage) {
  if (!installedPackage || typeof installedPackage !== 'object') {
    fail('artifact_metadata', 'installed package manifest is missing');
  }
  if (installedPackage.dependencies?.['@hono/node-server'] !== undefined) {
    fail('artifact_metadata', 'direct @hono/node-server dependency is forbidden');
  }
}

export function assertArtifactMetadata(packReport, installedPackage) {
  assertPackFilesSafe(requirePackFiles(packReport));
  assertInstalledPackageSafe(installedPackage);
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
  if (normalizedJobLines.includes('continue-on-error: true')) {
    fail('workflow_contract', 'continue-on-error is forbidden');
  }
  const verifierStep = findStepBlock(jobLines, verifierIndex);
  const publishStep = findStepBlock(jobLines, publishIndex);
  const publishCondition = publishStep
    .map(normalizeGuardLine)
    .find((line) => line.startsWith('if:'));
  if (publishCondition === 'if: always()' || publishCondition === 'if: failure()') {
    fail('workflow_contract', 'publish cannot run after a failed verifier');
  }
  const verifierText = verifierStep.join('\n');
  if (verifierText.includes('|| true') || verifierText.includes('set +e')) {
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
