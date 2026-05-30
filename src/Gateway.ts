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
 *       c. Upstream proxying via fast-proxy (streaming, low-latency).
 *  4. Handle errors and edge cases (404, 500) with minimal allocations.
 */

import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { URL } from 'node:url';

// ---------------------------------------------------------------------------
// ANSI color helpers — no third-party dependencies needed.
// These wrap a string with the escape code for the given color and always
// reset to default at the end, so surrounding text is never affected.
// ---------------------------------------------------------------------------
const ansi = {
  green:  (s: string) => `\x1b[32m${s}\x1b[0m`,
  cyan:   (s: string) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  bold:   (s: string) => `\x1b[1m${s}\x1b[0m`,
};

// fast-proxy ships a default export that is a factory function.
// We use a dynamic require here because the package's CJS/ESM interop
// does not expose named TypeScript types — the cast below keeps us safe.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const buildFastProxy = require('fast-proxy') as (
  opts: FastProxyOptions
) => { proxy: FastProxyFn; close: () => void };

import { Router } from './Router';
import { composePipeline } from './pipeline';
import type {
  GatewayContext,
  GatewayOptions,
  Plugin,
  RouteDefinition,
} from './types';

// ---------------------------------------------------------------------------
// fast-proxy type shims
// (fast-proxy does not ship its own @types package)
// ---------------------------------------------------------------------------

interface FastProxyOptions {
  /** Base URL of the upstream — fast-proxy uses this for connection reuse. */
  base?: string;
  /** Proxy request timeout in milliseconds. */
  timeout?: number;
  /** Undici/http agent options forwarded to the underlying HTTP client. */
  undici?: Record<string, unknown>;
}

type FastProxyFn = (
  req: IncomingMessage,
  res: ServerResponse,
  source: string,
  opts?: Record<string, unknown>
) => void;

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
   * fast-proxy instance. Initialised lazily on `start()` so the upstream
   * base URL can be set per-request rather than globally.
   * We keep a single instance with no fixed `base` and pass the full URL
   * per proxy call, which lets us support multiple upstreams.
   */
  private proxy!: FastProxyFn;
  private closeProxy!: () => void;

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
   * Starts the HTTP server and initialises the proxy engine.
   *
   * @returns A promise that resolves once the server is listening.
   */
  public start(): Promise<void> {
    // Initialise fast-proxy with no fixed base URL so we can proxy to
    // multiple different upstreams from a single gateway instance.
    const { proxy, close } = buildFastProxy({
      timeout: this.options.proxyTimeout,
      // Tune the undici connection pool for high-throughput scenarios.
      undici: {
        connections: 100,
        pipelining: 1,
      },
    });

    this.proxy = proxy;
    this.closeProxy = close;

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
      // Close the fast-proxy connection pool first to drain in-flight requests.
      if (this.closeProxy) {
        this.closeProxy();
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
   *  4. Stream the request to the upstream via fast-proxy.
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
   * Streams the request to the upstream service using fast-proxy.
   *
   * fast-proxy handles:
   *  - Forwarding all original headers.
   *  - Streaming the request body without buffering.
   *  - Streaming the upstream response body back to the client.
   *  - Setting appropriate `x-forwarded-*` headers.
   *
   * @param ctx - The populated GatewayContext for this request.
   */
  private proxyRequest(ctx: GatewayContext): Promise<void> {
    return new Promise((resolve, reject) => {
      // Build the full upstream URL by appending the original request path
      // to the upstream base URL. This preserves path params and query strings.
      const targetUrl = this.buildUpstreamUrl(ctx.upstream, ctx.req.url ?? '/');

      this.proxy(ctx.req, ctx.res, targetUrl, {
        // Instruct fast-proxy to rewrite the request URL to the target path.
        rewriteRequestHeaders: (
          _req: IncomingMessage,
          headers: Record<string, string>
        ) => {
          // Inject a custom header so upstream services can identify
          // traffic originating from the Jaunt gateway.
          headers['x-forwarded-by'] = 'jaunt-gateway';
          return headers;
        },
        onResponse: (_req: IncomingMessage, _res: ServerResponse) => {
          // Called by fast-proxy once the upstream response has been fully
          // piped to the client. Resolve the promise to signal completion.
          resolve();
        },
        onError: (err: Error) => {
          reject(err);
        },
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Constructs the full upstream target URL.
   *
   * Strips any existing origin from the upstream base and appends the
   * incoming request's path + query string.
   *
   * @param upstream - The upstream base URL (e.g. 'http://user-service:3000').
   * @param requestUrl - The raw request URL including path and query string.
   * @returns The fully-qualified upstream URL string.
   */
  private buildUpstreamUrl(upstream: string, requestUrl: string): string {
    try {
      const base = new URL(upstream);
      // Combine the upstream origin with the incoming request path.
      // Using URL constructor handles edge cases like double slashes.
      const target = new URL(requestUrl, base.origin);
      return target.toString();
    } catch {
      // Fallback: naive string concatenation if URL parsing fails.
      // This should not happen with well-formed upstream values.
      return upstream + requestUrl;
    }
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
   * Sends a plain-text HTTP error response and ends the response stream.
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
