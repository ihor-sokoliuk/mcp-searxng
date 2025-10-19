/**
 * Mock Server Helper
 * 
 * Creates mock MCP server objects for testing
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';

export interface MockServer {
  notification: (method: string, params: any) => void;
  _serverInfo: { name: string; version: string };
  _capabilities: Record<string, any>;
  connect?: (transport: any) => Promise<void>;
}

/**
 * Create a minimal mock server for testing
 */
export function createMockServer(overrides?: Partial<MockServer>): MockServer {
  const mockNotificationCalls: any[] = [];
  
  return {
    notification: (method: string, params: any) => {
      mockNotificationCalls.push({ method, params });
    },
    _serverInfo: { name: 'test', version: '1.0' },
    _capabilities: {},
    connect: async () => Promise.resolve(),
    ...overrides
  };
}

/**
 * Create a mock server that tracks notification calls
 */
export function createMockServerWithTracking(): {
  server: MockServer;
  getNotificationCalls: () => any[];
} {
  const mockNotificationCalls: any[] = [];
  
  const server: MockServer = {
    notification: (method: string, params: any) => {
      mockNotificationCalls.push({ method, params });
    },
    _serverInfo: { name: 'test', version: '1.0' },
    _capabilities: {},
    connect: async () => Promise.resolve(),
  };

  return {
    server,
    getNotificationCalls: () => mockNotificationCalls
  };
}
