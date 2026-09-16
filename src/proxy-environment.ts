// Shared inventory for diagnostic capture and configuration reporting.
// Routing precedence remains defined in proxy.ts.
export const PROXY_ENVIRONMENT_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "http_proxy",
  "https_proxy",
  "SEARCH_HTTP_PROXY",
  "SEARCH_HTTPS_PROXY",
  "search_http_proxy",
  "search_https_proxy",
  "URL_READER_HTTP_PROXY",
  "URL_READER_HTTPS_PROXY",
  "url_reader_http_proxy",
  "url_reader_https_proxy",
] as const;
