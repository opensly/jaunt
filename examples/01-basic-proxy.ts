/**
 * @file examples/01-basic-proxy.ts
 * @description The simplest possible Jaunt setup — no plugins, just routing
 * and proxying. Use this to verify the core proxy engine works end-to-end.
 *
 * Run:
 *   npm run example:01
 *
 * Test:
 *   curl -s http://localhost:4001/posts/1 | jq
 *   curl -s http://localhost:4001/posts?_limit=3 | jq
 *   curl -s http://localhost:4001/users/2 | jq
 *   curl -s http://localhost:4001/comments?postId=1 | jq
 *
 *   # Should return 404 JSON from Jaunt (no route registered)
 *   curl -s http://localhost:4001/unknown | jq
 */

import { Gateway } from '../src/index';

const gateway = new Gateway({ port: 4001 });

// ---------------------------------------------------------------------------
// Plain GET routes — no plugins, pure proxy passthrough
// ---------------------------------------------------------------------------

gateway
  .addRoute({
    method: 'GET',
    path: '/posts',
    upstream: 'https://jsonplaceholder.typicode.com',
  })
  .addRoute({
    method: 'GET',
    path: '/posts/:id',
    upstream: 'https://jsonplaceholder.typicode.com',
  })
  .addRoute({
    method: 'GET',
    path: '/users',
    upstream: 'https://jsonplaceholder.typicode.com',
  })
  .addRoute({
    method: 'GET',
    path: '/users/:id',
    upstream: 'https://jsonplaceholder.typicode.com',
  })
  .addRoute({
    method: 'GET',
    path: '/comments',
    upstream: 'https://jsonplaceholder.typicode.com',
  });

// ---------------------------------------------------------------------------
// POST route — verifies request body is streamed to upstream correctly
//
// Test:
//   curl -s -X POST http://localhost:4001/posts \
//     -H "Content-Type: application/json" \
//     -d '{"title":"Jaunt test","body":"hello","userId":1}' | jq
// ---------------------------------------------------------------------------
gateway.addRoute({
  method: 'POST',
  path: '/posts',
  upstream: 'https://jsonplaceholder.typicode.com',
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
