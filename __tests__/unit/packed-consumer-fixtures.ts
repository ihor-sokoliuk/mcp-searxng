export const safeTree = {
  name: 'consumer',
  version: '1.0.0',
  dependencies: {
    'mcp-searxng': {
      version: '1.12.0',
      dependencies: {
        '@modelcontextprotocol/sdk': {
          version: '1.30.0',
          dependencies: {
            '@hono/node-server': { version: '2.0.12' },
          },
        },
      },
    },
  },
};

export const validWorkflow = `name: Publish
jobs:
  build-and-publish:
    runs-on: ubuntu-latest
    steps:
      - name: Test package
        run: npm run test:coverage
      - name: Build package
        run: npm run build
      - name: Verify packed consumer
        run: npm run verify:packed-consumer -- --output "$RUNNER_TEMP/verified-package.tgz"
      - name: Publish to npm
        run: npm publish "$RUNNER_TEMP/verified-package.tgz" --access public --provenance
  publish-registry:
    needs: build-and-publish
    runs-on: ubuntu-latest
    steps:
      - run: echo complete
`;

export const zeroAudit = {
  metadata: {
    vulnerabilities: {
      info: 0,
      low: 0,
      moderate: 0,
      high: 0,
      critical: 0,
      total: 0,
    },
  },
};

export function commandResult(overrides: object): object {
  return {
    error: undefined,
    status: 0,
    signal: null,
    stdout: '',
    stderr: '',
    ...overrides,
  };
}

export function treeWithNodeServer(nodeServer: object): object {
  return {
    ...safeTree,
    dependencies: {
      'mcp-searxng': {
        version: '1.12.0',
        dependencies: {
          '@modelcontextprotocol/sdk': {
            version: '1.30.0',
            dependencies: {
              '@hono/node-server': nodeServer,
            },
          },
        },
      },
    },
  };
}

export function validMcpSmokeOutput(): string {
  return [
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: { protocolVersion: '2024-11-05' },
    }),
    JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      result: {
        tools: [
          { name: 'searxng_web_search' },
          { name: 'web_url_read' },
          { name: 'searxng_search_suggestions' },
          { name: 'searxng_instance_info' },
        ],
      },
    }),
  ].join('\n');
}
