/**
 * @file Gateway.ts
 * @description The central orchestrator of the Jaunt API Gateway.
 *
 * Responsibilities:
 *  1. Spin up a native Node.js HTTP server (no Express/Fastify overhead).
 *  2. Accept route registrations and delegate them to the Router.
 *  3. For every incoming request, execute the full lifecycle:
 *       a. Route matching via find-my-way (O(log n) Radix-tree lookup).
 *       b. Middleware pipeline execution (onion model).
 *       c. Upstream proxying via @fastify/reply-from's internal transport
 *          (undici-backed, streaming, low-latency).
 *  4. Handle errors and edge cases (404, 500) with minimal allocations.
 *
 * Proxy layer migration note:
 *  fast-proxy was deprecated upstream (replaced by @fastify/http-proxy).
 *  We now use the framework-agnostic `buildRequest` transport from
 *  @fastify/reply-from/lib/request directly, which is the same undici-backed
 *  engine without requiring Fastify as a peer dependency.
 */

import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { URL } from 'node:url';
import { pipeline } from 'node:stream';

// ---------------------------------------------------------------------------
// ANSI color helpers — no third-party dependencies needed.
// These wrap a string with the escape code for the given color and always
// reset to default at the end, so surrounding text is never affected.
// ---------------------------------------------------------------------------
const ansi = {
  cyan:   (s: string) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  bold:   (s: string) => `\x1b[1m${s}\x1b[0m`,
};

// ---------------------------------------------------------------------------
// @fastify/reply-from internal transport
//
// buildRequest is the framework-agnostic undici/http transport layer inside
// @fastify/reply-from. It has no dependency on Fastify's request/reply
// objects — it only needs a plain URL and headers, and returns a streaming
// response via callback. We use it directly here to avoid the Fastify plugin
// wrapper while still benefiting from the maintained undici connection pool.
// ---------------------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-require-imports
const buildRequest = require('@fastify/reply-from/lib/request') as (
  opts: ReplyFromRequestOptions
) => ReplyFromRequestResult;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { stripHttp1ConnectionHeaders } = require('@fastify/reply-from/lib/utils') as {
  stripHttp1ConnectionHeaders: (headers: Record<string, string | string[] | undefined>) => Record<string, string | string[] | undefined>;
};

import { Router } from './Router';
import { composePipeline } from './pipeline';
import type {
  GatewayContext,
  GatewayOptions,
  Plugin,
  RouteDefinition,
} from './types';

// ---------------------------------------------------------------------------
// Type shims for @fastify/reply-from internal API
// (the lib/ internals are not covered by the package's public .d.ts)
// ---------------------------------------------------------------------------

interface ReplyFromRequestOptions {
  /** No fixed base — we resolve the full URL per request for multi-upstream support. */
  base?: string;
  /** Undici connection pool options. */
  undici?: {
    connections?: number;
    pipelining?: number;
    keepAliveTimeout?: number;
  };
}

interface UpstreamResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  /** The upstream response body as a readable stream. */
  stream: IncomingMessage;
}

type RequestFn = (
  opts: {
    method: string;
    url: URL;
    qs: string;
    headers: Record<string, string | string[] | undefined>;
    body: IncomingMessage | string | undefined;
    timeout: number;
  },
  cb: (err: Error | null, res: UpstreamResponse) => void
) => void;

interface ReplyFromRequestResult {
  request: RequestFn;
  close: () => void;
  retryOnError: string;
}

// ---------------------------------------------------------------------------
// Gateway
// ---------------------------------------------------------------------------

/**
 * The main Jaunt Gateway class.
 *
 * @example
 * const gateway = new Gateway({ port: 8080 });
 *
 * gateway.addRoute({
 *   method: 'GET',
 *   path: '/api/users/:id',
 *   upstream: 'http://user-service:3000',
 *   plugins: [authPlugin],
 * });
 *
 * await gateway.start();
 */
export class Gateway {
  private readonly options: Required<GatewayOptions>;
  private readonly router: Router;
  private readonly server: http.Server;

  /**
   * The undici-backed request transport from @fastify/reply-from.
   * Initialised on `start()`. Kept as a single instance with no fixed base
   * so we can proxy to multiple different upstreams per request.
   */
  private requestFn!: RequestFn;
  private closeTransport!: () => void;

  constructor(options: GatewayOptions = {}) {
    // Apply defaults for every optional config key.
    this.options = {
      port: options.port ?? 3000,
      host: options.host ?? '0.0.0.0',
      globalPlugins: options.globalPlugins ?? [],
      proxyTimeout: options.proxyTimeout ?? 30_000,
    };

    this.router = new Router();

    // Create the HTTP server and bind the request handler.
    // Arrow function preserves `this` without an explicit bind call.
    this.server = http.createServer((req, res) => {
      void this.handleRequest(req, res);
    });
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Registers a route with the gateway.
   * Routes can be added before or after `start()` is called, enabling
   * dynamic route registration at runtime.
   *
   * @param route - The route definition to register.
   */
  public addRoute(route: RouteDefinition): this {
    this.router.add(route);
    return this; // Fluent API — allows chaining multiple addRoute() calls.
  }

  /**
   * Starts the HTTP server and initialises the proxy transport.
   *
   * @returns A promise that resolves once the server is listening.
   */
  public start(): Promise<void> {
    // Initialise the undici transport with no fixed base URL so we can proxy
    // to multiple different upstreams from a single gateway instance.
    const { request, close } = buildRequest({
      undici: {
        connections: 100,
        pipelining: 1,
      },
    });

    this.requestFn = request;
    this.closeTransport = close;

    return new Promise((resolve) => {
      this.server.listen(this.options.port, this.options.host, () => {
        console.log(
          'Jaunt Gateway listening on ' +
          ansi.cyan(ansi.bold(`http://${this.options.host}:${this.options.port}`))
        );
        console.log(ansi.yellow('\nRegistered routes:') + '\n' + this.router.prettyPrint());
        resolve();
      });
    });
  }

  /**
   * Gracefully shuts down the HTTP server and closes the proxy connection pool.
   *
   * @returns A promise that resolves once the server has fully closed.
   */
  public stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Drain the undici connection pool before closing the HTTP server.
      if (this.closeTransport) {
        this.closeTransport();
      }

      this.server.close((err) => {
        if (err) {
          reject(err);
        } else {
          console.log('Jaunt Gateway stopped.');
          resolve();
        }
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Request Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Core request handler — the hot path for every HTTP request.
   *
   * Lifecycle:
   *  1. Match the request URL against the Radix-tree route table.
   *  2. Build a GatewayContext with request metadata.
   *  3. Compose and execute the middleware pipeline (global + route-level).
   *  4. Stream the request to the upstream via the undici transport.
   *
   * @param req - Native Node.js IncomingMessage.
   * @param res - Native Node.js ServerResponse.
   */
  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    // ------------------------------------------------------------------
    // Step 1: Route matching
    // ------------------------------------------------------------------
    const match = this.router.match(req);

    if (!match) {
      this.sendError(res, 404, 'Not Found');
      return;
    }

    // ------------------------------------------------------------------
    // Step 2: Build context
    // ------------------------------------------------------------------
    const query = this.parseQuery(req.url ?? '/');

    const ctx: GatewayContext = {
      req,
      res,
      params: match.params,
      query,
      upstream: match.store.upstream,
      state: {},
    };

    // ------------------------------------------------------------------
    // Step 3: Compose and run the middleware pipeline
    //
    // Global plugins run first, followed by route-specific plugins.
    // This mirrors how frameworks like Koa handle global vs. router-level
    // middleware.
    // ------------------------------------------------------------------
    const allPlugins: Plugin[] = [
      ...this.options.globalPlugins,
      ...match.store.plugins,
    ];

    const runPipeline = composePipeline(allPlugins);

    try {
      await runPipeline(ctx);
    } catch (err) {
      // A plugin threw — log and return 500 before attempting to proxy.
      console.error('[Jaunt] Plugin pipeline error:', err);
      this.sendError(res, 500, 'Internal Server Error');
      return;
    }

    // If a plugin already sent a response (e.g. an auth plugin returning 401),
    // do not attempt to proxy the request.
    if (res.writableEnded) {
      return;
    }

    // ------------------------------------------------------------------
    // Step 4: Proxy to upstream
    // ------------------------------------------------------------------
    try {
      await this.proxyRequest(ctx);
    } catch (err) {
      console.error('[Jaunt] Proxy error:', err);
      if (!res.writableEnded) {
        this.sendError(res, 502, 'Bad Gateway');
      }
    }
  }

  /**
   * Streams the request to the upstream service using the undici transport
   * from @fastify/reply-from.
   *
   * The transport handles:
   *  - Forwarding all original headers (with hop-by-hop headers stripped).
   *  - Streaming the request body without buffering.
   *  - Streaming the upstream response body back to the client.
   *
   * @param ctx - The populated GatewayContext for this request.
   */
  private proxyRequest(ctx: GatewayContext): Promise<void> {
    return new Promise((resolve, reject) => {
      const rawUrl = ctx.req.url ?? '/';
      const upstreamUrl = this.buildUpstreamUrl(ctx.upstream, rawUrl);

      // Extract the query string portion to pass separately, as the transport
      // expects the path and query string to be provided independently.
      const qs = upstreamUrl.search;

      // Strip hop-by-hop headers (Connection, Transfer-Encoding, etc.) before
      // forwarding, then inject the gateway identification header.
      const forwardHeaders = stripHttp1ConnectionHeaders({
        ...ctx.req.headers,
      } as Record<string, string | string[] | undefined>);
      forwardHeaders['x-forwarded-by'] = 'jaunt-gateway';
      forwardHeaders['host'] = upstreamUrl.host;

      this.requestFn(
        {
          method: ctx.req.method ?? 'GET',
          url: upstreamUrl,
          qs,
          headers: forwardHeaders,
          // Pass the raw IncomingMessage as the body stream so the transport
          // can pipe it directly without buffering.
          body: ctx.req,
          timeout: this.options.proxyTimeout,
        },
        (err, upstreamRes) => {
          if (err) {
            reject(err);
            return;
          }

          // Write the upstream status and headers to the client response.
          const outHeaders: Record<string, string | string[]> = {};
          for (const [key, value] of Object.entries(upstreamRes.headers)) {
            if (value !== undefined) {
              outHeaders[key] = value;
            }
          }
          ctx.res.writeHead(upstreamRes.statusCode, outHeaders);

          // Stream the upstream response body directly to the client.
          // `pipeline` handles cleanup on error or early close.
          pipeline(upstreamRes.stream, ctx.res, (pipeErr) => {
            if (pipeErr) {
              // The client may have disconnected mid-stream; log but don't
              // reject since the response head was already sent.
              console.error('[Jaunt] Stream pipeline error:', pipeErr);
            }
            resolve();
          });
        }
      );
    });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Constructs the full upstream target URL object.
   *
   * Combines the upstream base origin with the incoming request's path
   * and query string.
   *
   * @param upstream - The upstream base URL (e.g. 'http://user-service:3000').
   * @param requestUrl - The raw request URL including path and query string.
   * @returns A parsed URL pointing at the upstream target.
   */
  private buildUpstreamUrl(upstream: string, requestUrl: string): URL {
    const base = new URL(upstream);
    // Resolve the incoming path against the upstream origin.
    // Using the URL constructor handles edge cases like double slashes.
    return new URL(requestUrl, base.origin);
  }

  /**
   * Parses the query string from a raw URL into a plain key/value map.
   *
   * @param rawUrl - The raw request URL string (e.g. '/search?q=hello&page=2').
   * @returns A flat record of query parameter key/value pairs.
   */
  private parseQuery(rawUrl: string): Record<string, string> {
    try {
      // Use a dummy base so URL can parse relative paths.
      const { searchParams } = new URL(rawUrl, 'http://localhost');
      const query: Record<string, string> = {};
      searchParams.forEach((value, key) => {
        query[key] = value;
      });
      return query;
    } catch {
      return {};
    }
  }

  /**
   * Sends a JSON HTTP error response and ends the response stream.
   *
   * @param res - The ServerResponse to write to.
   * @param statusCode - HTTP status code (e.g. 404, 500).
   * @param message - Human-readable error message.
   */
  private sendError(
    res: ServerResponse,
    statusCode: number,
    message: string
  ): void {
    if (res.writableEnded) return;

    const body = JSON.stringify({ error: message, statusCode });
    res.writeHead(statusCode, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
  }
}
