import { strict as assert } from 'node:assert';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createHttpServer } from '../../src/http-server.js';
import { createMcpServer, createToolAdmissionController } from '../../src/index.js';
import { resetDiagnosticSanitizerForTests } from '../../src/diagnostic-sanitizer.js';
import { urlCache } from '../../src/cache.js';
import { clearInstanceInfoCacheForTests } from '../../src/instance-info.js';
import { createTextPdf } from '../helpers/pdf-fixtures.js';
import { snapshotProcessEnv, restoreProcessEnv } from '../helpers/env-utils.js';
import { createTestResults, testFunction, printTestSummary } from '../helpers/test-utils.js';

async function listen(server: http.Server) {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: http.Server) {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}

export async function runTests() {
  const results = createTestResults();
  for (const transportKind of ['stdio','http']) {
    await testFunction(`real ${transportKind} content boundaries preserve wire auth and withhold reflected credentials`, async () => {
      const saved = snapshotProcessEnv();
      const password = ['wire','fixture','marker'].join('-');
      const auth = `Basic ${Buffer.from(`wire-user:${password}`).toString('base64')}`;
      const observed: Array<{path:string;auth:string|undefined}> = [];
      let configFailure = true;
      const target = http.createServer((req,res) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        observed.push({path:url.pathname,auth:req.headers.authorization});
        if (url.pathname === '/v1') {
          let body = '';
          req.setEncoding('utf8');
          req.on('data', chunk => {body += String(chunk);});
          req.on('end', () => {
            const input = JSON.parse(body) as {url:string};
            res.setHeader('content-type','application/json');
            res.end(JSON.stringify({status:'ok',solution:{url:input.url,status:200,cookies:[],userAgent:'fixture-browser'}}));
          });
        } else if (url.pathname.endsWith('/config')) {
          if (configFailure) { res.writeHead(401, `Denied ${auth}`); res.end(); }
          else { res.setHeader('content-type','application/json'); res.end(JSON.stringify({plugins:[auth]})); }
        } else if (url.pathname.endsWith('/autocompleter')) {
          res.setHeader('content-type','application/json'); res.end(JSON.stringify(['query',[auth]]));
        } else if (url.pathname.endsWith('/search')) {
          res.setHeader('content-type','application/json');
          res.end(JSON.stringify({results:[{title:'Fixture',url:'https://example.test/',content:url.searchParams.get('q') === 'safe' ? 'Ordinary content' : auth}]}));
        } else if (url.pathname.endsWith('/pdf')) {
          res.setHeader('content-type','application/pdf'); res.end(createTextPdf([password]));
        } else if (url.pathname.endsWith('/json')) {
          res.setHeader('content-type','application/json'); res.end(JSON.stringify({data:password}));
        } else {
          res.setHeader('content-type','text/html'); res.end(`<h1>Fixture</h1><p>Before ${password} after</p>`);
        }
      });
      const targetUrl = await listen(target);
      let mcpHttp: http.Server | undefined;
      const client = new Client({name:'wire-output-test',version:'1'}, {capabilities:{logging:{}}});
      const logs: unknown[] = [];
      let stderr = '';
      client.setNotificationHandler('notifications/message', event => {logs.push(event);});
      try {
        for (const key of Object.keys(process.env)) if (/proxy|^AUTH_|^SEARXNG_|^MCP_HTTP_|^FLARESOLVERR|^BYPARR/i.test(key)) delete process.env[key];
        const configured = new URL(targetUrl + '/subpath/');
        configured.username = 'wire-user'; configured.password = password;
        process.env.SEARXNG_URL = configured.href;
        process.env.MCP_HTTP_ALLOW_PRIVATE_URLS = 'true';
        resetDiagnosticSanitizerForTests(); clearInstanceInfoCacheForTests();
        if (transportKind === 'stdio') {
          const transport = new StdioClientTransport({command:process.execPath,args:['--import','tsx','src/cli.ts'],cwd:process.cwd(),env:process.env as Record<string,string>,stderr:'pipe'});
          transport.stderr?.on('data', chunk => {stderr += String(chunk);});
          await client.connect(transport);
        } else {
          const controller = createToolAdmissionController();
          mcpHttp = http.createServer(await createHttpServer(modern => createMcpServer(controller, modern)));
          const base = await listen(mcpHttp);
          await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), {requestInit:{headers:{Host:'127.0.0.1'}}}));
        }
        const resource = await client.readResource({uri:'config://server-config'});
        assert.ok(!JSON.stringify(resource).includes(password));
        const safe = await client.callTool({name:'searxng_web_search',arguments:{query:'safe'}});
        assert.equal(safe.isError, undefined);
        assert.equal((safe.content[0] as {text:string}).text, 'Title: Fixture\nDescription: Ordinary content\nURL: https://example.test/');
        const search = await client.callTool({name:'searxng_web_search',arguments:{query:'reflect'}});
        assert.equal(search.isError,true);
        const suggestions = await client.callTool({name:'searxng_search_suggestions',arguments:{query:'reflect'}});
        assert.equal(suggestions.isError,true);
        for (let attempt=0; attempt<2; attempt++) {
          const info = await client.callTool({name:'searxng_instance_info',arguments:{refresh:attempt === 0}});
          assert.ok(!JSON.stringify(info).includes(auth));
        }
        assert.equal(observed.filter(r=>r.path.endsWith('/config')).length,1,'negative cache retained');
        configFailure=false;
        const info = await client.callTool({name:'searxng_instance_info',arguments:{refresh:true}});
        assert.equal(info.isError,true);
        for (const path of ['/page','/json','/pdf']) {
          for (const options of [{}, {startChar:12,maxLength:5}, {section:'Fixture'}, {paragraphRange:'1-1'}, {readHeadings:true}]) {
            const result = await client.callTool({name:'web_url_read',arguments:{url:targetUrl+path,...options}});
            assert.equal(result.isError,true,JSON.stringify(result));
            assert.ok(!JSON.stringify(result).includes(password));
          }
        }
        if (transportKind === 'http') {
          const cached = targetUrl + '/cached';
          urlCache.set(cached, `Before ${password} after`);
          const result = await client.callTool({name:'web_url_read',arguments:{url:cached,startChar:7,maxLength:5}});
          assert.equal(result.isError,true);
          assert.ok(!observed.some(r=>r.path === '/cached'));
          process.env.FLARESOLVERR_URL = targetUrl;
          const solved = await client.callTool({name:'web_url_read',arguments:{url:targetUrl+'/solver-page',maxLength:5}});
          assert.equal(solved.isError,true);
          assert.ok(observed.some(r=>r.path === '/v1'));
          assert.ok(observed.some(r=>r.path === '/solver-page'));
        }
        assert.ok(observed.filter(r=>r.path.startsWith('/subpath/')).every(r=>r.auth === auth));
        assert.ok(observed.filter(r=>!r.path.startsWith('/subpath/')).every(r=>r.auth === undefined));
        await client.close();
        const diagnostics = JSON.stringify({logs,stderr});
        assert.ok(!diagnostics.includes(password)); assert.ok(!diagnostics.includes(auth));
      } finally {
        await client.close(); if (mcpHttp) await close(mcpHttp); await close(target);
        urlCache.clear(); clearInstanceInfoCacheForTests(); restoreProcessEnv(saved); resetDiagnosticSanitizerForTests();
      }
    }, results);
  }
  printTestSummary(results,'Credential output wire');
  return results;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runTests().then(r => {process.exitCode = r.failed ? 1 : 0;}).catch(error => {console.error(error);process.exitCode=1;});
}
