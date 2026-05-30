# Jaunt

A high-performance, lightweight API Gateway core for Node.js, written in TypeScript.

Jaunt is built on three primitives with no heavy framework in the middle:

| Concern | Library |
|---|---|
| HTTP server | Node.js native `http` module |
| Route matching | [`find-my-way`](https://github.com/delvedor/find-my-way) — Radix-tree router |
| Upstream proxying | [`fast-proxy`](https://github.com/fastify/fast-proxy) — streaming HTTP proxy |

---

## Features

- **Zero-framework core** — raw Node.js HTTP for maximum throughput
- **O(log n) route matching** via a Radix-tree, powered by `find-my-way`
- **Streaming proxy** — request and response bodies are never buffered, piped directly via `fast-proxy`
- **Onion-style middleware pipeline** — Koa-inspired async plugin model with full pre/post proxy control
- **Dynamic route registration** — add routes at any point, including after the server has started
- **Global and per-route plugins** — cross-cutting concerns (logging, auth, rate limiting) at either scope
- **Fully typed** — strict TypeScript throughout, with exported interfaces for all public contracts
- **Fluent API** — chainable `addRoute()` calls for clean setup code

---

## Requirements

- Node.js `>= 20.0.0`
- TypeScript `>= 5.x`

---

## Installation

```bash
npm install jaunt
```

---

## Quick Start

```typescript
import { Gateway } from 'jaunt';
import type { Plugin } from 'jaunt';

// A simple request logger plugin
const logger: Plugin = async (ctx, next) => {
  const start = Date.now();
  await next();
  console.log(`${ctx.req.method} ${ctx.req.url} → ${ctx.res.statusCode} (${Date.now() - start}ms)`);
};

const gateway = new Gateway({
  port: 3000,
  globalPlugins: [logger],
});

gateway
  .addRoute({
    method: 'GET',
    path: '/api/users/:id',
    upstream: 'http://user-service:3000',
  })
  .addRoute({
    method: 'POST',
    path: '/api/orders',
    upstream: 'http://order-service:4000',
  });

await gateway.start();
// 🚀 Jaunt Gateway listening on http://0.0.0.0:3000
```

// HTTP/1.1 upstream — unchanged, no migration needed
```typescript
gateway.addRoute({
  method: 'GET',
  path: '/api/users/:id',
  upstream: 'http://user-service:3000',
});
```

// HTTP/2 upstream — simple
```typescript
gateway.addRoute({
  method: 'POST',
  path: '/api/orders',
  upstream: 'https://order-service:4000',
  http2: true,
});
```

// HTTP/2 upstream — with custom timeouts and self-signed cert
```typescript
gateway.addRoute({
  method: 'GET',
  path: '/api/inventory',
  upstream: 'https://inventory-service:5000',
  http2: {
    sessionTimeout: 30_000,
    requestTimeout: 5_000,
    rejectUnauthorized: false, // dev only
  },
});
```

---

## Request Lifecycle

Every request that hits the gateway goes through four steps in order:

```
Incoming Request
      │
      ▼
 1. Route Match (find-my-way Radix tree)
      │  no match → 404
      ▼
 2. Build GatewayContext
      │  (params, query, upstream, state)
      ▼
 3. Plugin Pipeline  ──────────────────────────────────────────┐
      │  Global plugins → Route plugins (onion model)          │
      │  Plugin short-circuits (no next()) → skip proxy        │
      ▼                                                         │
 4. Upstream Proxy (fast-proxy streaming)                       │
      │  upstream error → 502                                   │
      ▼                                                    (post-proxy
 Response streamed back to client                          code runs here)
```

---

## API Reference

### `new Gateway(options?)`

Creates a new gateway instance.

| Option | Type | Default | Description |
|---|---|---|---|
| `port` | `number` | `3000` | Port to listen on |
| `host` | `string` | `'0.0.0.0'` | Hostname or IP to bind |
| `globalPlugins` | `Plugin[]` | `[]` | Plugins that run on every request, before route-level plugins |
| `proxyTimeout` | `number` | `30000` | Upstream request timeout in milliseconds |

---

### `gateway.addRoute(route)`

Registers a route. Returns `this` for chaining.

```typescript
gateway.addRoute({
  method: 'GET',           // HttpMethod — GET | POST | PUT | PATCH | DELETE | HEAD | OPTIONS
  path: '/users/:id',      // find-my-way path pattern
  upstream: 'http://...',  // Base URL of the upstream service
  plugins: [],             // Optional route-level plugin array
});
```

Routes can be added dynamically at any time, including after `gateway.start()` has been called.

---

### `gateway.start()`

Starts the HTTP server and initialises the proxy connection pool.

```typescript
await gateway.start();
```

Returns a `Promise<void>` that resolves once the server is listening.

---

### `gateway.stop()`

Gracefully shuts down the server and drains the proxy connection pool.

```typescript
await gateway.stop();
```

---

### `GatewayContext`

The context object passed to every plugin.

```typescript
interface GatewayContext {
  req: IncomingMessage;            // Raw Node.js request
  res: ServerResponse;             // Raw Node.js response
  params: Record<string, string>;  // Path parameters, e.g. { id: '42' }
  query: Record<string, string>;   // Query string parameters
  upstream: string;                // Upstream base URL for this route
  state: Record<string, unknown>;  // Free-form state bag for inter-plugin data
}
```

---

### `Plugin`

The middleware function signature.

```typescript
type Plugin = (ctx: GatewayContext, next: () => Promise<void>) => Promise<void>;
```

- Call `await next()` to pass control to the next plugin (and eventually the proxy).
- Omit `next()` to short-circuit the pipeline — the request will not be proxied.
- Code **before** `next()` runs on the way in (pre-proxy).
- Code **after** `next()` runs on the way out (post-proxy).

---

## Plugin Examples

### Request Logger

```typescript
const logger: Plugin = async (ctx, next) => {
  const start = Date.now();
  console.log(`--> ${ctx.req.method} ${ctx.req.url}`);
  await next();
  console.log(`<-- ${ctx.res.statusCode} (${Date.now() - start}ms)`);
};
```

### API Key Authentication

```typescript
const apiKeyAuth: Plugin = async (ctx, next) => {
  if (ctx.req.headers['x-api-key'] !== process.env.API_KEY) {
    ctx.res.writeHead(401, { 'Content-Type': 'application/json' });
    ctx.res.end(JSON.stringify({ error: 'Unauthorized' }));
    return; // Do not call next() — pipeline stops here
  }
  await next();
};
```

### Request URL Rewriting

```typescript
// Map /api/users/:id → /users/:id on the upstream
const rewritePath: Plugin = async (ctx, next) => {
  ctx.req.url = `/users/${ctx.params['id']}`;
  await next();
};
```

### Sharing State Between Plugins

```typescript
const injectRequestId: Plugin = async (ctx, next) => {
  ctx.state['requestId'] = crypto.randomUUID();
  await next();
};

const useRequestId: Plugin = async (ctx, next) => {
  const id = ctx.state['requestId'] as string;
  ctx.req.headers['x-request-id'] = id;
  await next();
};
```

---

## Project Structure

```
jaunt/
├── src/
│   ├── index.ts       # Public package entry point — re-exports all public API
│   ├── Gateway.ts     # HTTP server, request lifecycle orchestration
│   ├── Router.ts      # find-my-way wrapper — route registration and matching
│   ├── pipeline.ts    # Onion-style async middleware composer
│   └── types.ts       # All TypeScript interfaces and type definitions
├── examples/
│   └── basic-gateway.ts   # Working demo with logger, auth, and path rewriting
├── package.json
└── tsconfig.json
```

---

## Running the Example

The example proxies to [JSONPlaceholder](https://jsonplaceholder.typicode.com), a free public REST API.

```bash
npm install
npx ts-node examples/basic-gateway.ts
```

Then in another terminal:

```bash
# Public route — no auth
curl http://localhost:4000/posts/1

# Route with path param rewriting (/api/users/:id → /users/:id upstream)
curl http://localhost:4000/api/users/3

# Protected route — missing key, returns 401
curl http://localhost:4000/protected/data

# Protected route — valid key, proxied to upstream
curl -H "x-api-key: secret-key-123" http://localhost:4000/protected/data
```

---

## Building

```bash
npm run build        # Compile TypeScript to dist/
npm run build:watch  # Watch mode
npm run clean        # Remove dist/
```

---

## License

MIT
