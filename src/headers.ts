import { createConfigurationError } from "./error-handler.js";

export type HeaderRecord = Record<string, string>;

function normalizeHeaders(headers?: HeadersInit): HeaderRecord {
  if (!headers) {
    return {};
  }

  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }

  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }

  return { ...headers };
}

export function parseHeadersFromEnv(envVarName: string): HeaderRecord {
  const rawHeaders = process.env[envVarName];
  if (!rawHeaders) {
    return {};
  }

  let parsedHeaders: unknown;
  try {
    parsedHeaders = JSON.parse(rawHeaders);
  } catch {
    throw createConfigurationError(`${envVarName} must be valid JSON`);
  }

  if (
    typeof parsedHeaders !== "object" ||
    parsedHeaders === null ||
    Array.isArray(parsedHeaders)
  ) {
    throw createConfigurationError(`${envVarName} must be a JSON object`);
  }

  const headers: HeaderRecord = {};
  for (const [name, value] of Object.entries(parsedHeaders)) {
    if (name.trim() === "") {
      throw createConfigurationError(`${envVarName} contains an empty header name`);
    }

    if (typeof value !== "string") {
      throw createConfigurationError(`${envVarName}.${name} must be a string`);
    }

    headers[name] = value;
  }

  return headers;
}

export function mergeHeaders(headers: HeadersInit | undefined, additionalHeaders: HeaderRecord): HeaderRecord {
  return {
    ...normalizeHeaders(headers),
    ...additionalHeaders,
  };
}
