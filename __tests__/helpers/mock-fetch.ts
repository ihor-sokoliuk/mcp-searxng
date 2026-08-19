/**
 * Mock Fetch Helper
 * 
 * Utilities for mocking fetch API in tests
 */

import { searchCache } from '../../src/search-cache.js';
import { setSearxngFetchForTesting } from '../../src/proxy.js';

export type FetchMockOptions = {
  status?: number;
  statusText?: string;
  ok?: boolean;
  body?: string;
  json?: any;
  throwError?: Error;
};

/**
 * Create a mock fetch response
 */
export function createMockFetch(options: FetchMockOptions = {}) {
  const {
    status = 200,
    statusText = 'OK',
    ok = true,
    body = '',
    json = null,
    throwError = null
  } = options;

  return async (url: string | URL | Request, requestOptions?: RequestInit): Promise<Response> => {
    if (throwError) {
      throw throwError;
    }

    // Give consumers a real, readable body stream. Preserve the helper's
    // historical json override for callers that deliberately pass both forms.
    const response = new Response(body || (json !== null ? JSON.stringify(json) : ''), {
      status,
      statusText,
    });
    Object.defineProperty(response, 'ok', { value: ok });
    Object.defineProperty(response, 'json', {
      value: async () => {
        if (json !== null) {
          return json;
        }
        if (body) {
          return JSON.parse(body);
        }
        throw new Error('No JSON content');
      },
    });
    return response;
  };
}

/**
 * Create a mock fetch that captures the request
 */
export function createCapturingMockFetch() {
  let capturedUrl: string = '';
  let capturedOptions: RequestInit | undefined;

  const mockFetch = async (url: string | URL | Request, options?: RequestInit): Promise<Response> => {
    capturedUrl = url.toString();
    capturedOptions = options;
    
    return new Response(JSON.stringify({ results: [] }), {
      status: 200,
      statusText: 'OK',
    });
  };

  return {
    mockFetch,
    getCapturedUrl: () => capturedUrl,
    getCapturedOptions: () => capturedOptions
  };
}

/**
 * Create a mock fetch that throws on abort
 */
export function createAbortableMockFetch(delayMs: number = 50) {
  return async (url: string | URL | Request, options?: RequestInit): Promise<Response> => {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const abortError = new Error('The operation was aborted');
        abortError.name = 'AbortError';
        reject(abortError);
      }, delayMs);

      if (options?.signal) {
        options.signal.addEventListener('abort', () => {
          clearTimeout(timeout);
          const abortError = new Error('The operation was aborted');
          abortError.name = 'AbortError';
          reject(abortError);
        });
      }
    });
  };
}

/**
 * Replace and restore the shared SearXNG fetch implementation
 */
export class FetchMocker {
  mock(mockFetch: typeof global.fetch): void {
    setSearxngFetchForTesting(mockFetch);
  }

  restore(): void {
    setSearxngFetchForTesting();
    searchCache.clear();
  }
}
