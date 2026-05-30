/**
 * @file examples/04-http2-upstream.ts
 * @description Demonstrates HTTP/2 upstream support in Jaunt.
 *
 * Architecture
 * ────────────
 * This example is fully self-contained — no external services required.
 * It spins up two servers in the same process:
 *
 *   ┌─────────────────────────────────────────────────────────────────┐
 *   │  curl (HTTP/1.1)  →  Jaunt Gateway :4004  →  h2 upstream :4005 │
 *   │                       (HTTP/1.1 inbound)    (HTTP/2 outbound)   │
 *   └─────────────────────────────────────────────────────────────────┘
 *
 *  • The upstream is a plain Node.js `http2.createServer` (h2c — cleartext
 *    HTTP/2, no TLS). This is fine for local testing; production upstreams
 *    typically use TLS (`https://`).
 *  • The gateway accepts HTTP/1.1 from clients and bridges to HTTP/2 on the
 *    upstream side — the classic h1→h2 translation pattern.
 *  • Jaunt maintains ONE persistent HTTP/2 session per upstream origin,
 *    shared across all routes targeting that origin.
 *
 * Run:
 *   npm run example:04
 *
 * Test suite (in a separate terminal):
 *
 *   # Basic GET — response comes from the h2 upstream
 *   curl -s http://localhost:4004/hello | jq
 *
 *   # Path parameter — :name is extracted by the router
 *   curl -s http://localhost:4004/greet/world | jq
 *
 *   # Query string forwarding
 *   curl -s "http://localhost:4004/echo?foo=bar&baz=qux" | jq
 *
 *   # POST with body — verifies request body is streamed over h2
 *   curl -s -X POST http://localhost:4004/echo \
 *     -H "Content-Type: application/json" \
 *     -d '{"message":"hello from h1 client"}' | jq
 *
 *   # Protocol header — upstream reports the protocol it received on
 *   curl -s http://localhost:4004/protocol | jq
 *
 *   # Concurrent requests — all multiplexed over the single h2 session
 *   for i in $(seq 1 6); do curl -s http://localhost:4004/hello & done; wait
 *
 *   # Verify x-forwarded-by header is present in upstream logs (check server output)
 *   curl -sv http://localhost:4004/hello 2>&1 | grep -i x-forwarded
 */

import http2, {
  type Http2ServerRequest,
  type Http2ServerResponse,
  type IncomingHttpHeaders,
} from 'node:http2';
import { Gateway } from '../src/index';
import type { Plugin } from '../src/index';

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------
const c = {
  grey:    (s: string) => `\x1b[90m${s}\x1b[0m`,
  green:   (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow:  (s: string) => `\x1b[33m${s}\x1b[0m`,
  red:     (s: string) => `\x1b[31m${s}\x1b[0m`,
  blue:    (s: string) => `\x1b[34m${s}\x1b[0m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
  cyan:    (s: string) => `\x1b[36m${s}\x1b[0m`,
  bold:    (s: string) => `\x1b[1m${s}\x1b[0m`,
};

const UPSTREAM_PORT = 4005;
const GATEWAY_PORT  = 4004;

// ---------------------------------------------------------------------------
// Step 1: HTTP/2 upstream server (h2c — cleartext, no TLS)
//
// Handles a small set of routes that return JSON, and logs every request
// with the protocol version so we can confirm h2 is being used.
// ---------------------------------------------------------------------------

/**
 * Reads the full request body from an HTTP/2 server request stream.
 */
function readBody(req: Http2ServerRequest): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Sends a JSON response from the HTTP/2 upstream.
 */
function sendJson(res: Http2ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(statusCode, {
    'content-type': 'application/json',
    'x-served-by': 'jaunt-h2-upstream',
  });
  res.end(payload);
}

const upstreamServer = http2.createServer(
  async (req: Http2ServerRequest, res: Http2ServerResponse) => {
    const method  = req.method ?? 'GET';
    const url     = req.url ?? '/';
    const proto   = `HTTP/${req.httpVersion}`;

    // Log every inbound request so we can confirm the gateway is using h2.
    console.log(
      c.blue('[upstream]') +
      ` ${c.bold(method)} ${url}` +
      c.grey(` via ${proto}`) +
      (req.headers['x-forwarded-by']
        ? c.grey(` forwarded-by=${req.headers['x-forwarded-by']}`)
        : '')
    );

    // Route: GET /hello
    if (method === 'GET' && url === '/hello') {
      sendJson(res, 200, {
        message: 'Hello from the HTTP/2 upstream!',
        protocol: proto,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Route: GET /greet/:name  (simple prefix match)
    const greetMatch = /^\/greet\/([^/?]+)/.exec(url);
    if (method === 'GET' && greetMatch) {
      sendJson(res, 200, {
        greeting: `Hello, ${greetMatch[1]}!`,
        protocol: proto,
      });
      return;
    }

    // Route: GET|POST /echo — reflects method, headers, query, and body
    if (url.startsWith('/echo')) {
      const body = method !== 'GET' && method !== 'HEAD'
        ? await readBody(req)
        : undefined;

      // Collect safe headers (exclude HTTP/2 pseudo-headers starting with ':')
      const safeHeaders: IncomingHttpHeaders = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (!k.startsWith(':')) safeHeaders[k] = v;
      }

      sendJson(res, 200, {
        method,
        url,
        protocol: proto,
        headers: safeHeaders,
        body: body ? tryParseJson(body) : undefined,
      });
      return;
    }

    // Route: GET /protocol — explicitly reports the inbound protocol
    if (method === 'GET' && url === '/protocol') {
      sendJson(res, 200, {
        inboundProtocol: proto,
        httpVersion: req.httpVersion,
        isHttp2: req.httpVersion === '2.0',
        note: 'This is what the upstream received from the gateway.',
      });
      return;
    }

    // 404 fallback
    sendJson(res, 404, { error: 'Not Found', url });
  }
);

// ---------------------------------------------------------------------------
// Step 2: Jaunt gateway plugins
// ---------------------------------------------------------------------------

/**
 * Global logger — shows the full request/response cycle including timing.
 */
const logger: Plugin = async (ctx, next) => {
  const start = Date.now();
  console.log(
    c.cyan('→') +
    ` ${c.bold(ctx.req.method ?? 'GET')} ${ctx.req.url}` +
    c.grey(' (HTTP/1.1 inbound → HTTP/2 upstream)')
  );

  await next();

  const ms = Date.now() - start;
  const status = ctx.res.statusCode;
  const col = status < 300 ? c.green : status < 500 ? c.yellow : c.red;

  console.log(
    c.cyan('←') +
    ` ${c.bold(ctx.req.method ?? 'GET')} ${ctx.req.url}` +
    ` ${col(String(status))}` +
    c.grey(` ${ms}ms`)
  );
};

// ---------------------------------------------------------------------------
// Step 3: Jaunt gateway — all routes use http2: true
// ---------------------------------------------------------------------------

const gateway = new Gateway({
  port: GATEWAY_PORT,
  globalPlugins: [logger],
  proxyTimeout: 10_000,
});

gateway
  // Simple GET
  .addRoute({
    method: 'GET',
    path: '/hello',
    upstream: `http://localhost:${UPSTREAM_PORT}`,
    http2: true,
  })
  // Path parameter — router extracts :name, upstream receives /greet/:name
  .addRoute({
    method: 'GET',
    path: '/greet/:name',
    upstream: `http://localhost:${UPSTREAM_PORT}`,
    http2: true,
  })
  // GET echo — query string forwarding
  .addRoute({
    method: 'GET',
    path: '/echo',
    upstream: `http://localhost:${UPSTREAM_PORT}`,
    http2: true,
  })
  // POST echo — request body streaming over h2
  .addRoute({
    method: 'POST',
    path: '/echo',
    upstream: `http://localhost:${UPSTREAM_PORT}`,
    http2: true,
  })
  // Protocol probe — upstream reports what protocol it received
  .addRoute({
    method: 'GET',
    path: '/protocol',
    upstream: `http://localhost:${UPSTREAM_PORT}`,
    http2: true,
  })
  // Fine-grained h2 options — custom timeouts, self-signed cert tolerance
  .addRoute({
    method: 'GET',
    path: '/hello-custom',
    upstream: `http://localhost:${UPSTREAM_PORT}`,
    http2: {
      sessionTimeout: 30_000,
      requestTimeout: 5_000,
      rejectUnauthorized: false,
    },
  });

// ---------------------------------------------------------------------------
// Step 4: Start upstream first, then gateway
// ---------------------------------------------------------------------------

function shutdown(): void {
  console.log(c.yellow('\nShutting down...'));
  gateway.stop()
    .then(() => new Promise<void>((resolve, reject) =>
      upstreamServer.close((err) => err ? reject(err) : resolve())
    ))
    .then(() => {
      console.log(c.grey('All servers stopped.'));
      process.exit(0);
    })
    .catch(() => process.exit(1));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Start the upstream h2 server first, then the gateway.
upstreamServer.listen(UPSTREAM_PORT, '127.0.0.1', () => {
  console.log(
    c.blue('[upstream]') +
    ` HTTP/2 server listening on ${c.bold(`http://localhost:${UPSTREAM_PORT}`)}`
  );

  gateway.start().then(() => {
    console.log(c.magenta('\n── Test commands ──────────────────────────────────────────'));
    console.log(c.grey('  curl -s http://localhost:4004/hello | jq'));
    console.log(c.grey('  curl -s http://localhost:4004/greet/world | jq'));
    console.log(c.grey('  curl -s "http://localhost:4004/echo?foo=bar&baz=qux" | jq'));
    console.log(c.grey('  curl -s -X POST http://localhost:4004/echo \\'));
    console.log(c.grey('    -H "Content-Type: application/json" \\'));
    console.log(c.grey('    -d \'{"message":"hello from h1 client"}\' | jq'));
    console.log(c.grey('  curl -s http://localhost:4004/protocol | jq'));
    console.log(c.magenta('───────────────────────────────────────────────────────────\n'));
  }).catch((err: unknown) => {
    console.error('Failed to start gateway:', err);
    process.exit(1);
  });
});

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function tryParseJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}
