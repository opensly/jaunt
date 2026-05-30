/**
 * @file examples/basic-gateway.ts
 * @description A working demonstration of the Jaunt API Gateway.
 *
 * This example:
 *  1. Creates a Gateway instance on port 4000.
 *  2. Attaches a global request-logger plugin.
 *  3. Registers a route that proxies to the public JSONPlaceholder API.
 *  4. Registers a route with a route-level auth-check plugin.
 *  5. Starts the server.
 *
 * Run with:
 *   npx ts-node examples/basic-gateway.ts
 *
 * Then test with:
 *   curl http://localhost:4000/posts/1
 *   curl http://localhost:4000/api/users/42
 *   curl http://localhost:4000/protected/data
 */

import { Gateway } from '../src/index';
import type { Plugin } from '../src/index';

// ---------------------------------------------------------------------------
// Global Plugin: Request Logger
// ---------------------------------------------------------------------------
// Runs for every route registered on this gateway instance.
// Logs the method, URL, and response status code with timing.

const requestLogger: Plugin = async (ctx, next) => {
  const start = Date.now();
  const { method, url } = ctx.req;

  console.log(`--> [${new Date().toISOString()}] ${method} ${url}`);

  // Yield control to the next plugin (or the proxy if this is the last plugin).
  await next();

  const duration = Date.now() - start;
  console.log(
    `<-- [${new Date().toISOString()}] ${method} ${url} ${ctx.res.statusCode} (${duration}ms)`
  );
};

// ---------------------------------------------------------------------------
// Route-level Plugin: Dummy API Key Auth
// ---------------------------------------------------------------------------
// Only applied to routes that explicitly include it.
// Checks for an `x-api-key` header and short-circuits with 401 if missing.

const apiKeyAuth: Plugin = async (ctx, next) => {
  const apiKey = ctx.req.headers['x-api-key'];

  if (!apiKey || apiKey !== 'secret-key-123') {
    console.warn(`[Auth] Rejected request — invalid or missing x-api-key`);

    ctx.res.writeHead(401, { 'Content-Type': 'application/json' });
    ctx.res.end(
      JSON.stringify({
        error: 'Unauthorized',
        message: 'A valid x-api-key header is required.',
      })
    );

    // Do NOT call next() — this terminates the pipeline and prevents proxying.
    return;
  }

  console.log(`[Auth] API key validated for ${ctx.req.url}`);
  await next();
};

// ---------------------------------------------------------------------------
// Route-level Plugin: Path Parameter Inspector
// ---------------------------------------------------------------------------
// Demonstrates how to read path params from ctx.params inside a plugin.

const paramInspector: Plugin = async (ctx, next) => {
  if (Object.keys(ctx.params).length > 0) {
    console.log(`[Params] Extracted path params:`, ctx.params);
  }
  if (Object.keys(ctx.query).length > 0) {
    console.log(`[Query]  Extracted query params:`, ctx.query);
  }
  await next();
};

// ---------------------------------------------------------------------------
// Gateway Setup
// ---------------------------------------------------------------------------

const gateway = new Gateway({
  port: 4000,
  host: '0.0.0.0',

  // Global plugins run before any route-level plugins on every request.
  globalPlugins: [requestLogger],

  // Upstream proxy timeout: 10 seconds for this demo.
  proxyTimeout: 10_000,
});

// ---------------------------------------------------------------------------
// Route: Public posts — no auth required
// Proxies to JSONPlaceholder, a free public REST API for testing.
//
// Try: curl http://localhost:4000/posts
//      curl http://localhost:4000/posts/1
// ---------------------------------------------------------------------------
gateway.addRoute({
  method: 'GET',
  path: '/posts',
  upstream: 'https://jsonplaceholder.typicode.com',
  plugins: [paramInspector],
});

gateway.addRoute({
  method: 'GET',
  path: '/posts/:id',
  upstream: 'https://jsonplaceholder.typicode.com',
  plugins: [paramInspector],
});

// ---------------------------------------------------------------------------
// Route: User service — demonstrates named path params
// Proxies to JSONPlaceholder's /users endpoint.
//
// Try: curl http://localhost:4000/api/users/1
// ---------------------------------------------------------------------------
gateway.addRoute({
  method: 'GET',
  path: '/api/users/:id',
  upstream: 'https://jsonplaceholder.typicode.com',
  plugins: [
    paramInspector,
    // Rewrite the upstream path to map /api/users/:id → /users/:id
    // This shows how a plugin can mutate ctx.req.url before proxying.
    async (ctx, next) => {
      const userId = ctx.params['id'];
      // Rewrite the request URL so fast-proxy forwards to /users/:id
      ctx.req.url = `/users/${userId}`;
      await next();
    },
  ],
});

// ---------------------------------------------------------------------------
// Route: Protected endpoint — requires a valid API key header
//
// Try (should fail):    curl http://localhost:4000/protected/data
// Try (should succeed): curl -H "x-api-key: secret-key-123" http://localhost:4000/protected/data
// ---------------------------------------------------------------------------
gateway.addRoute({
  method: 'GET',
  path: '/protected/data',
  upstream: 'https://jsonplaceholder.typicode.com',
  plugins: [
    apiKeyAuth,
    // Only reached if apiKeyAuth calls next()
    async (ctx, next) => {
      // Rewrite to a valid JSONPlaceholder endpoint for demo purposes.
      ctx.req.url = '/todos/1';
      await next();
    },
  ],
});

// ---------------------------------------------------------------------------
// Start the gateway
// ---------------------------------------------------------------------------
gateway.start().catch((err: unknown) => {
  console.error('Failed to start Jaunt Gateway:', err);
  process.exit(1);
});

// Graceful shutdown on SIGINT (Ctrl+C) and SIGTERM.
const shutdown = () => {
  console.log('\nShutting down Jaunt Gateway...');
  gateway.stop().then(() => process.exit(0)).catch(() => process.exit(1));
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
