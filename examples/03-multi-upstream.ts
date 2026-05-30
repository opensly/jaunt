/**
 * @file examples/03-multi-upstream.ts
 * @description Tests routing to multiple different upstream services from a
 * single gateway instance. Also demonstrates dynamic route registration
 * after the server has started, rate limiting via a token-bucket plugin,
 * and response header injection.
 *
 * Run:
 *   npm run example:03
 *
 * Test suite:
 *
 *   # Upstream A — JSONPlaceholder posts
 *   curl -s http://localhost:4003/posts/1 | jq
 *
 *   # Upstream B — JSONPlaceholder users (different upstream base)
 *   curl -s http://localhost:4003/users/1 | jq
 *
 *   # Upstream C — JSONPlaceholder todos
 *   curl -s http://localhost:4003/todos/1 | jq
 *
 *   # Rate limiter — hammer this endpoint; after 5 req/s you get 429
 *   for i in $(seq 1 8); do curl -s -o /dev/null -w "%{http_code}\n" http://localhost:4003/limited/posts/1; done
 *
 *   # Dynamic route — registered 3 seconds after startup
 *   # (wait 3s after starting the server, then run)
 *   curl -s http://localhost:4003/dynamic/albums/1 | jq
 *
 *   # Verify x-powered-by and x-request-id response headers are present
 *   curl -sI http://localhost:4003/posts/1
 */

import { Gateway } from '../src/index';
import type { Plugin, GatewayContext } from '../src/index';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------
const c = {
  grey:    (s: string) => `\x1b[90m${s}\x1b[0m`,
  green:   (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow:  (s: string) => `\x1b[33m${s}\x1b[0m`,
  red:     (s: string) => `\x1b[31m${s}\x1b[0m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
  cyan:    (s: string) => `\x1b[36m${s}\x1b[0m`,
  bold:    (s: string) => `\x1b[1m${s}\x1b[0m`,
};

// ---------------------------------------------------------------------------
// Plugin: Request ID + header injector
// ---------------------------------------------------------------------------
const headerInjector: Plugin = async (ctx, next) => {
  const requestId = randomUUID();
  ctx.state['requestId'] = requestId;
  ctx.req.headers['x-request-id'] = requestId;
  ctx.req.headers['x-powered-by'] = 'jaunt-gateway';
  await next();
};

// ---------------------------------------------------------------------------
// Plugin: Structured logger
// ---------------------------------------------------------------------------
const logger: Plugin = async (ctx, next) => {
  const start = Date.now();
  const id = (ctx.state['requestId'] as string | undefined)?.slice(0, 8) ?? '--------';

  console.log(
    c.cyan('→') + ` ${c.bold(ctx.req.method ?? 'GET')} ${ctx.req.url}` +
    c.grey(` upstream=${ctx.upstream}`) +
    c.grey(` [${id}]`)
  );

  await next();

  const ms = Date.now() - start;
  const status = ctx.res.statusCode;
  const col = status < 300 ? c.green : status < 500 ? c.yellow : c.red;

  console.log(
    c.cyan('←') + ` ${c.bold(ctx.req.method ?? 'GET')} ${ctx.req.url}` +
    ` ${col(String(status))} ${c.grey(`${ms}ms`)}`
  );
};

// ---------------------------------------------------------------------------
// Plugin factory: Token-bucket rate limiter
// Allows `maxRequests` per `windowMs` per IP address.
// Returns 429 Too Many Requests when the bucket is exhausted.
// ---------------------------------------------------------------------------
function createRateLimiter(maxRequests: number, windowMs: number): Plugin {
  const buckets = new Map<string, { count: number; resetAt: number }>();

  return async (ctx: GatewayContext, next: () => Promise<void>) => {
    const ip =
      (ctx.req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim()
      ?? ctx.req.socket.remoteAddress
      ?? 'unknown';

    const now = Date.now();
    let bucket = buckets.get(ip);

    if (!bucket || now > bucket.resetAt) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(ip, bucket);
    }

    bucket.count++;

    if (bucket.count > maxRequests) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      console.log(c.red(`  [RateLimit] ${ip} exceeded ${maxRequests} req/${windowMs}ms — 429`));

      ctx.res.writeHead(429, {
        'Content-Type': 'application/json',
        'Retry-After': String(retryAfter),
        'X-RateLimit-Limit': String(maxRequests),
        'X-RateLimit-Remaining': '0',
        'X-RateLimit-Reset': String(Math.ceil(bucket.resetAt / 1000)),
      });
      ctx.res.end(JSON.stringify({
        error: 'Too Many Requests',
        retryAfterSeconds: retryAfter,
      }));
      return;
    }

    console.log(c.grey(`  [RateLimit] ${ip} — ${bucket.count}/${maxRequests} in window`));
    await next();
  };
}

// ---------------------------------------------------------------------------
// Gateway setup
// ---------------------------------------------------------------------------
const gateway = new Gateway({
  port: 4003,
  globalPlugins: [headerInjector, logger],
  proxyTimeout: 15_000,
});

// Upstream A: posts
gateway
  .addRoute({ method: 'GET', path: '/posts',     upstream: 'https://jsonplaceholder.typicode.com' })
  .addRoute({ method: 'GET', path: '/posts/:id', upstream: 'https://jsonplaceholder.typicode.com' });

// Upstream B: users
gateway
  .addRoute({ method: 'GET', path: '/users',     upstream: 'https://jsonplaceholder.typicode.com' })
  .addRoute({ method: 'GET', path: '/users/:id', upstream: 'https://jsonplaceholder.typicode.com' });

// Upstream C: todos
gateway
  .addRoute({ method: 'GET', path: '/todos',     upstream: 'https://jsonplaceholder.typicode.com' })
  .addRoute({ method: 'GET', path: '/todos/:id', upstream: 'https://jsonplaceholder.typicode.com' });

// Rate-limited route — max 5 requests per 10 seconds per IP
const rateLimiter = createRateLimiter(5, 10_000);

gateway.addRoute({
  method: 'GET',
  path: '/limited/posts/:id',
  upstream: 'https://jsonplaceholder.typicode.com',
  plugins: [
    rateLimiter,
    async (ctx, next) => {
      ctx.req.url = `/posts/${ctx.params['id']}`;
      await next();
    },
  ],
});

// ---------------------------------------------------------------------------
// Start, then register a dynamic route 3 seconds later
// ---------------------------------------------------------------------------
function shutdown(): void {
  gateway.stop().then(() => process.exit(0)).catch(() => process.exit(1));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

gateway.start().then(() => {
  console.log(c.magenta('\n⏳ Dynamic route will be registered in 3 seconds...'));
  console.log(c.grey('   Try: curl http://localhost:4003/dynamic/albums/1 (will 404 for now)\n'));

  setTimeout(() => {
    gateway.addRoute({
      method: 'GET',
      path: '/dynamic/albums/:id',
      upstream: 'https://jsonplaceholder.typicode.com',
      plugins: [
        async (ctx, next) => {
          ctx.req.url = `/albums/${ctx.params['id']}`;
          await next();
        },
      ],
    });
    console.log(c.green('\n✔ Dynamic route /dynamic/albums/:id registered.'));
    console.log(c.grey('  Try: curl http://localhost:4003/dynamic/albums/1\n'));
  }, 3_000);

}).catch((err: unknown) => {
  console.error('Failed to start gateway:', err);
  process.exit(1);
});
