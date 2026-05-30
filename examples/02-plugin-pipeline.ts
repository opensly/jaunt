/**
 * @file examples/02-plugin-pipeline.ts
 * @description Exercises the full plugin pipeline — global plugins, route-level
 * plugins, pipeline ordering, short-circuiting, state sharing, and URL rewriting.
 *
 * Run:
 *   npm run example:02
 *
 * Test suite (run each curl in order and observe the server logs):
 *
 *   # 1. Global logger fires, no route plugins — plain proxy
 *   curl -s http://localhost:4002/posts/1 | jq
 *
 *   # 2. Global logger + paramInspector — logs path & query params
 *   curl -s "http://localhost:4002/posts/5?_format=json" | jq
 *
 *   # 3. URL rewrite: /api/users/3 → proxied as /users/3
 *   curl -s http://localhost:4002/api/users/3 | jq
 *
 *   # 4. Pipeline short-circuit: missing API key → 401, upstream never called
 *   curl -s http://localhost:4002/secure/todos/1 | jq
 *
 *   # 5. Pipeline passes: valid API key → 200 from upstream
 *   curl -s -H "x-api-key: jaunt-secret" http://localhost:4002/secure/todos/1 | jq
 *
 *   # 6. State sharing between plugins — check server log for [RequestId]
 *   curl -s http://localhost:4002/posts | jq
 */

import { Gateway } from '../src/index';
import type { Plugin } from '../src/index';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// ANSI helpers (same pattern as Gateway.ts — no third-party deps)
// ---------------------------------------------------------------------------
const c = {
  grey:   (s: string) => `\x1b[90m${s}\x1b[0m`,
  green:  (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red:    (s: string) => `\x1b[31m${s}\x1b[0m`,
  cyan:   (s: string) => `\x1b[36m${s}\x1b[0m`,
  bold:   (s: string) => `\x1b[1m${s}\x1b[0m`,
};

// ---------------------------------------------------------------------------
// Plugin 1 (global): Request ID injector
// Generates a UUID per request, stores it in ctx.state, and forwards it
// as a request header so the upstream can correlate logs.
// ---------------------------------------------------------------------------
const requestId: Plugin = async (ctx, next) => {
  const id = randomUUID();
  ctx.state['requestId'] = id;

  // Forward to upstream
  ctx.req.headers['x-request-id'] = id;

  await next();

  // Post-proxy: confirm the ID was carried through
  console.log(c.grey(`  [RequestId] ${id} completed with status ${ctx.res.statusCode}`));
};

// ---------------------------------------------------------------------------
// Plugin 2 (global): Structured request logger
// Demonstrates pre/post proxy hooks in a single plugin.
// ---------------------------------------------------------------------------
const structuredLogger: Plugin = async (ctx, next) => {
  const start = Date.now();
  const id = ctx.state['requestId'] as string ?? '-';

  console.log(
    c.cyan('→') +
    ` ${c.bold(ctx.req.method ?? 'GET')} ${ctx.req.url}` +
    c.grey(` [${id.slice(0, 8)}]`)
  );

  await next();

  const ms = Date.now() - start;
  const status = ctx.res.statusCode;
  const statusColor = status < 300 ? c.green : status < 500 ? c.yellow : c.red;

  console.log(
    c.cyan('←') +
    ` ${c.bold(ctx.req.method ?? 'GET')} ${ctx.req.url}` +
    ` ${statusColor(String(status))}` +
    c.grey(` ${ms}ms`)
  );
};

// ---------------------------------------------------------------------------
// Plugin 3 (route-level): Path & query param inspector
// ---------------------------------------------------------------------------
const paramInspector: Plugin = async (ctx, next) => {
  if (Object.keys(ctx.params).length > 0) {
    console.log(c.yellow('  [Params]'), ctx.params);
  }
  if (Object.keys(ctx.query).length > 0) {
    console.log(c.yellow('  [Query] '), ctx.query);
  }
  await next();
};

// ---------------------------------------------------------------------------
// Plugin 4 (route-level): API key auth — short-circuits on failure
// ---------------------------------------------------------------------------
const apiKeyAuth: Plugin = async (ctx, next) => {
  const key = ctx.req.headers['x-api-key'];

  if (key !== 'jaunt-secret') {
    console.log(c.red('  [Auth] REJECTED — invalid or missing x-api-key'));
    ctx.res.writeHead(401, { 'Content-Type': 'application/json' });
    ctx.res.end(JSON.stringify({
      error: 'Unauthorized',
      hint: 'Pass header: x-api-key: jaunt-secret',
    }));
    // Not calling next() — pipeline stops, upstream is never contacted.
    return;
  }

  console.log(c.green('  [Auth] PASSED'));
  await next();
};

// ---------------------------------------------------------------------------
// Plugin 5 (route-level): URL rewriter
// Maps /api/users/:id → /users/:id on the upstream.
// Shows how a plugin can mutate ctx.req.url before the proxy step.
// ---------------------------------------------------------------------------
const rewriteUserPath: Plugin = async (ctx, next) => {
  const original = ctx.req.url;
  ctx.req.url = `/users/${ctx.params['id']}`;
  console.log(c.yellow(`  [Rewrite] ${original} → ${ctx.req.url}`));
  await next();
};

// ---------------------------------------------------------------------------
// Gateway — two global plugins run on every request
// ---------------------------------------------------------------------------
const gateway = new Gateway({
  port: 4002,
  globalPlugins: [requestId, structuredLogger],
});

// Plain proxy — only global plugins fire
gateway.addRoute({
  method: 'GET',
  path: '/posts',
  upstream: 'https://jsonplaceholder.typicode.com',
});

// Route with param + query inspection
gateway.addRoute({
  method: 'GET',
  path: '/posts/:id',
  upstream: 'https://jsonplaceholder.typicode.com',
  plugins: [paramInspector],
});

// URL rewriting — /api/users/:id proxied as /users/:id
gateway.addRoute({
  method: 'GET',
  path: '/api/users/:id',
  upstream: 'https://jsonplaceholder.typicode.com',
  plugins: [paramInspector, rewriteUserPath],
});

// Auth-protected route — pipeline short-circuits without valid key
gateway.addRoute({
  method: 'GET',
  path: '/secure/todos/:id',
  upstream: 'https://jsonplaceholder.typicode.com',
  plugins: [
    apiKeyAuth,
    // Only reached when auth passes — rewrites path to /todos/:id
    async (ctx, next) => {
      ctx.req.url = `/todos/${ctx.params['id']}`;
      await next();
    },
  ],
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
function shutdown(): void {
  gateway.stop().then(() => process.exit(0)).catch(() => process.exit(1));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

gateway.start().catch((err: unknown) => {
  console.error('Failed to start gateway:', err);
  process.exit(1);
});
