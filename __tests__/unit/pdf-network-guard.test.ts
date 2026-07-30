import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import {
  ExternalFetchAttemptError,
  installPdfNetworkGuards,
} from "../../src/pdf-network-guard.js";
import { createTestResults, printTestSummary, testFunction } from "../helpers/test-utils.js";

export async function runTests() {
  const results = createTestResults();

  await testFunction("blocks PDF worker fetch and socket egress and restores every channel", () => {
    const originals = {
      fetch: globalThis.fetch,
      httpGet: http.get,
      httpRequest: http.request,
      httpsGet: https.get,
      httpsRequest: https.request,
      netConnect: net.connect,
      netCreateConnection: net.createConnection,
      tlsConnect: tls.connect,
    };

    const restore = installPdfNetworkGuards();
    try {
      for (const operation of [
        () => globalThis.fetch("https://example.com"),
        () => http.get("http://example.com"),
        () => http.request("http://example.com"),
        () => https.get("https://example.com"),
        () => https.request("https://example.com"),
        () => net.connect(80, "example.com"),
        () => net.createConnection(80, "example.com"),
        () => tls.connect(443, "example.com"),
      ]) {
        assert.throws(operation, ExternalFetchAttemptError);
      }
    } finally {
      restore();
    }

    assert.equal(globalThis.fetch, originals.fetch);
    assert.equal(http.get, originals.httpGet);
    assert.equal(http.request, originals.httpRequest);
    assert.equal(https.get, originals.httpsGet);
    assert.equal(https.request, originals.httpsRequest);
    assert.equal(net.connect, originals.netConnect);
    assert.equal(net.createConnection, originals.netCreateConnection);
    assert.equal(tls.connect, originals.tlsConnect);
  }, results);

  printTestSummary(results, "PDF Network Guard");
  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void runTests();
}
