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
 *       c. Upstream proxying — HTTP/1.1 via undici or HTTP/2 via a persistent
 *          h2 session, selected per-route.
 *  4. Handle errors and edge cases (404, 500) with minimal allocations.
 *
 * HTTP/2 upstream support:
 *  Routes may set `http2: true` (or an `Http2UpstreamOptions` object) to have
 *  Jaunt open a persistent HTTP/2 session to the upstream origin. The inbound
 *  client connection always uses HTTP/1.1 — this is a pure h1→h2 bridge.
 *
 *  Jaunt maintains one transport instance per unique upstream origin+protocol
 *  combination. Transports are created lazily on first use and reused for all
 *  subsequent requests to the same origin, giving connection multiplexing for
 *  HTTP/2 and connection pooling for HTTP/1.1.
 */

import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { URL } from 'node:url';
import { pipeline } from 'node:stream';

// ---------------------------------------------------------------------------
// ANSI color helpers — no third-party dependencies needed.
// ---------------------------------------------------------------------------
const ansi = {
  cyan:   (s: string) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  bold:   (s: string) => `\x1b[1m${s}\x1b[0m`,
};

// ---------------------------------------------------------------------------
// @fastify/reply-from internal transport
//
// buildRequest is the framework-agnostic undici/http2 transport layer inside
// @fastify/reply-from. It has no dependency on Fastify's request/reply
// objects — it only needs a plain URL and headers, and returns a streaming
// response via callback.
//
// For HTTP/1.1 routes we create one shared transport with no fixed base,
// letting undici's agent pool handle connections to any upstream.
//
// For HTTP/2 routes, buildRequest requires a fixed `base` URL (one h2 session
// per origin), so we maintain a registry keyed by upstream origin.
// ---------------------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-require-imports
const buildRequest = require('@fastify/reply-from/lib/request') as (
  opts: ReplyFromRequestOptions
) => ReplyFromRequestResult;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { stripHttp1ConnectionHeaders, filterPseudoHeaders } = require('@fastify/reply-from/lib/utils') as {
  stripHttp1ConnectionHeaders: (
    headers: Record<string, string | string[] | undefined>
  ) => Record<string, string | string[] | undefined>;
  filterPseudoHeaders: (
    headers: Record<string, string | string[] | undefined>
  ) => Record<string, string | string[] | undefined>;
};

import { Router } from './Router';
import { composePipeline } from './pipeline';
import type {
  GatewayContext,
  GatewayOptions,
  Http2UpstreamOptions,
  Plugin,
  RouteDefinition,
} from './types';

// ---------------------------------------------------------------------------
// Type shims for @fastify/reply-from internal API
// (lib/ internals are not covered by the package's public .d.ts)
// ---------------------------------------------------------------------------

interface ReplyFromHttp2Options {
  sessionTimeout?: number;
  requestTimeout?: number;
  sessionOptions?: { rejectUnauthorized?: boolean };
}

interface ReplyFromRequestOptions {
  /** Fixed upstream origin — required when http2 is enabled. */
  base?: string;
  /** Pass truthy/object to use the HTTP/2 transport. */
  http2?: boolean | ReplyFromHttp2Options;
  /** Undici connection pool options (HTTP/1.1 only). */
  undici?: {
    connections?: number;
    pipelining?: number;
    keepAliveTimeout?: number;
  };
}

interface UpstreamResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  /** Readable stream of the upstream response body. */
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
// Transport registry entry
// ---------------------------------------------------------------------------

interface TransportEntry {
  requestFn: RequestFn;
  close: () => void;
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
 * // HTTP/1.1 upstream (default)
 * gateway.addRoute({
 *   method: 'GET',
 *   path: '/api/users/:id',
 *   upstream: 'http://user-service:3000',
 *   plugins: [authPlugin],
 * });
 *
 * // HTTP/2 upstream
 * gateway.addRoute({
 *   method: 'GET',
 *   path: '/api/orders',
 *   upstream: 'https://order-service:4000',
 *   http2: true,
 * });
 *
 * await gateway.start();
 */
export class Gateway {
  private readonly options: Required<GatewayOptions>;
  private readonly router: Router;
  private readonly server: http.Server;

  /**
   * Shared HTTP/1.1 transport (undici-backed, no fixed base).
   * Initialised on `start()`.
   */
  private h1Transport!: TransportEntry;

  /**
   * Per-origin HTTP/2 transport registry.
   * Key: upstream origin string (e.g. 'https://order-service:4000').
   * Created lazily on first request to each h2 upstream.
   */
  private readonly h2Transports = new Map<string, TransportEntry>();

  constructor(options: GatewayOptions = {}) {
    this.options = {
      port: options.port ?? 3000,
      host: options.host ?? '0.0.0.0',
      globalPlugins: options.globalPlugins ?? [],
      proxyTimeout: options.proxyTimeout ?? 30_000,
    };

    this.router = new Router();

    this.server = http.createServer((req, res) => {
      void this.handleRequest(req, res);
    });
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Registers a route with the gateway.
   * Routes can be added before or after `start()` is called.
   *
   * @param route - The route definition to register.
   */
  public addRoute(route: RouteDefinition): this {
    this.router.add(route);
    return this;
  }

  /**
   * Starts the HTTP server and initialises the HTTP/1.1 proxy transport.
   * HTTP/2 transports are created lazily on first use.
   *
   * @returns A promise that resolves once the server is listening.
   */
  public start(): Promise<void> {
    // Shared HTTP/1.1 transport — no fixed base, undici agent handles pooling.
    const { request, close } = buildRequest({
      undici: {
        connections: 100,
        pipelining: 1,
      },
    });

    this.h1Transport = { requestFn: request, close };

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
   * Gracefully shuts down the HTTP server and closes all proxy transports
   * (both the shared HTTP/1.1 pool and every HTTP/2 session).
   *
   * @returns A promise that resolves once the server has fully closed.
   */
  public stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Close the HTTP/1.1 undici pool.
      this.h1Transport?.close();

      // Destroy every HTTP/2 session.
      for (const [, entry] of this.h2Transports) {
        entry.close();
      }
      this.h2Transports.clear();

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
   *  4. Proxy to upstream via HTTP/1.1 (undici) or HTTP/2, per route config.
   */
  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    // Step 1: Route matching
    const match = this.router.match(req);
    if (!match) {
      this.sendError(res, 404, 'Not Found');
      return;
    }

    // Step 2: Build context
    const ctx: GatewayContext = {
      req,
      res,
      params: match.params,
      query: this.parseQuery(req.url ?? '/'),
      upstream: match.store.upstream,
      state: {},
    };

    // Step 3: Middleware pipeline
    const allPlugins: Plugin[] = [
      ...this.options.globalPlugins,
      ...match.store.plugins,
    ];

    try {
      await composePipeline(allPlugins)(ctx);
    } catch (err) {
      console.error('[Jaunt] Plugin pipeline error:', err);
      this.sendError(res, 500, 'Internal Server Error');
      return;
    }

    if (res.writableEnded) return;

    // Step 4: Proxy
    try {
      await this.proxyRequest(ctx, match.store.http2);
    } catch (err) {
      console.error('[Jaunt] Proxy error:', err);
      if (!res.writableEnded) {
        this.sendError(res, 502, 'Bad Gateway');
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Proxy
  // ---------------------------------------------------------------------------

  /**
   * Proxies the request to the upstream service.
   *
   * Selects the correct transport based on the route's `http2` setting:
   *  - Falsy → shared HTTP/1.1 undici transport.
   *  - Truthy → per-origin HTTP/2 transport (created lazily, then reused).
   *
   * @param ctx      - The populated GatewayContext for this request.
   * @param http2Cfg - The route's http2 setting from RouteStore.
   */
  private proxyRequest(
    ctx: GatewayContext,
    http2Cfg: boolean | Http2UpstreamOptions
  ): Promise<void> {
    const transport = http2Cfg
      ? this.getOrCreateH2Transport(ctx.upstream, http2Cfg)
      : this.h1Transport;

    return this.dispatchRequest(ctx, transport);
  }

  /**
   * Returns the cached HTTP/2 transport for the given upstream origin,
   * creating and caching a new one if this is the first request to that origin.
   *
   * One HTTP/2 session is maintained per unique upstream origin. All routes
   * targeting the same origin share the session, giving full h2 multiplexing.
   *
   * @param upstream  - The upstream base URL string.
   * @param http2Cfg  - The route's http2 setting (true or options object).
   */
  private getOrCreateH2Transport(
    upstream: string,
    http2Cfg: boolean | Http2UpstreamOptions
  ): TransportEntry {
    const origin = new URL(upstream).origin;

    const existing = this.h2Transports.get(origin);
    if (existing) return existing;

    // Normalise the http2 config into the shape buildRequest expects.
    const h2Opts: ReplyFromHttp2Options =
      typeof http2Cfg === 'object' && http2Cfg !== null
        ? {
            sessionTimeout: http2Cfg.sessionTimeout,
            requestTimeout: http2Cfg.requestTimeout,
            sessionOptions: {
              rejectUnauthorized: http2Cfg.rejectUnauthorized,
            },
          }
        : {};

    const { request, close } = buildRequest({
      base: origin,
      http2: Object.keys(h2Opts).length > 0 ? h2Opts : true,
    });

    const entry: TransportEntry = { requestFn: request, close };
    this.h2Transports.set(origin, entry);

    console.log(`[Jaunt] HTTP/2 transport created for ${ansi.cyan(origin)}`);
    return entry;
  }

  /**
   * Sends the request through the given transport and pipes the upstream
   * response stream back to the client.
   *
   * For HTTP/2 upstreams the response `stream` is a `ClientHttp2Stream`
   * (readable after the `response` event). For HTTP/1.1 it is an
   * `IncomingMessage`. Both are Node.js `Readable` streams, so `pipeline`
   * handles both identically.
   *
   * HTTP/2 response headers include `:status` and other pseudo-headers
   * (prefixed with `:`). These are filtered out before writing to the
   * HTTP/1.1 client response, since pseudo-headers are not valid in h1.
   *
   * @param ctx       - The populated GatewayContext.
   * @param transport - The resolved transport entry to use.
   */
  private dispatchRequest(
    ctx: GatewayContext,
    transport: TransportEntry
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const rawUrl = ctx.req.url ?? '/';
      const upstreamUrl = this.buildUpstreamUrl(ctx.upstream, rawUrl);
      const qs = upstreamUrl.search;

      // Strip hop-by-hop headers before forwarding, then inject the
      // gateway identification header and correct Host.
      const forwardHeaders = stripHttp1ConnectionHeaders({
        ...ctx.req.headers,
      } as Record<string, string | string[] | undefined>);
      forwardHeaders['x-forwarded-by'] = 'jaunt-gateway';
      forwardHeaders['host'] = upstreamUrl.host;

      transport.requestFn(
        {
          method: ctx.req.method ?? 'GET',
          url: upstreamUrl,
          qs,
          headers: forwardHeaders,
          body: ctx.req,
          timeout: this.options.proxyTimeout,
        },
        (err, upstreamRes) => {
          if (err) {
            reject(err);
            return;
          }

          // Filter out HTTP/2 pseudo-headers (`:status`, `:path`, etc.)
          // before writing to the HTTP/1.1 client response — they are
          // illegal in HTTP/1.1 and would cause a write error.
          const safeHeaders = filterPseudoHeaders(
            upstreamRes.headers as Record<string, string | string[] | undefined>
          );

          const outHeaders: Record<string, string | string[]> = {};
          for (const [key, value] of Object.entries(safeHeaders)) {
            if (value !== undefined) {
              outHeaders[key] = value;
            }
          }

          ctx.res.writeHead(upstreamRes.statusCode, outHeaders);

          // Stream the upstream response body to the client without buffering.
          pipeline(upstreamRes.stream, ctx.res, (pipeErr) => {
            if (pipeErr) {
              // Client may have disconnected mid-stream; the response head
              // was already sent so we can only log, not send an error.
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
   */
  private buildUpstreamUrl(upstream: string, requestUrl: string): URL {
    const base = new URL(upstream);
    return new URL(requestUrl, base.origin);
  }

  /**
   * Parses the query string from a raw URL into a plain key/value map.
   */
  private parseQuery(rawUrl: string): Record<string, string> {
    try {
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
