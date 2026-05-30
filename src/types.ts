/**
 * @file types.ts
 * @description Core TypeScript interfaces and types for the Jaunt API Gateway.
 * All public-facing contracts are defined here to ensure a clean, typed API
 * surface for consumers of this module.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/**
 * The request context object passed through the middleware pipeline.
 * It wraps the native Node.js IncomingMessage and ServerResponse, and carries
 * any route-level metadata extracted during routing (e.g. path parameters).
 *
 * Plugins may attach arbitrary state to `ctx.state` for inter-plugin
 * communication without polluting the request/response objects directly.
 */
export interface GatewayContext {
  /** The raw incoming HTTP request from Node's native http module. */
  req: IncomingMessage;

  /** The raw outgoing HTTP response from Node's native http module. */
  res: ServerResponse;

  /**
   * Path parameters extracted by the router from the URL pattern.
   * e.g. for route '/users/:id', a request to '/users/42' yields { id: '42' }
   */
  params: Record<string, string>;

  /**
   * Parsed query string parameters from the request URL.
   * e.g. '/search?q=hello' yields { q: 'hello' }
   */
  query: Record<string, string>;

  /**
   * The upstream target URL this request will be proxied to.
   * Set by the router when a route is matched.
   */
  upstream: string;

  /**
   * A free-form state bag for plugins to share data across the pipeline.
   * Strongly typed as unknown to force consumers to perform their own
   * type narrowing when reading values.
   */
  state: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Plugins / Middleware
// ---------------------------------------------------------------------------

/**
 * A single middleware function in the plugin pipeline.
 *
 * Follows the "onion" (Koa-style) pattern:
 *   - Call `await next()` to pass control to the next plugin.
 *   - Code before `next()` runs on the way *in* (pre-proxy).
 *   - Code after `next()` runs on the way *out* (post-proxy / response).
 *
 * @example
 * const logger: Plugin = async (ctx, next) => {
 *   console.log(`--> ${ctx.req.method} ${ctx.req.url}`);
 *   await next();
 *   console.log(`<-- ${ctx.res.statusCode}`);
 * };
 */
export type Plugin = (
  ctx: GatewayContext,
  next: () => Promise<void>
) => Promise<void>;

// ---------------------------------------------------------------------------
// Route Definition
// ---------------------------------------------------------------------------

/**
 * Supported HTTP methods for route registration.
 * Mirrors the methods accepted by find-my-way.
 */
export type HttpMethod =
  | 'GET'
  | 'POST'
  | 'PUT'
  | 'PATCH'
  | 'DELETE'
  | 'HEAD'
  | 'OPTIONS';

/**
 * A complete route definition registered with the Jaunt gateway.
 *
 * @example
 * const route: RouteDefinition = {
 *   method: 'GET',
 *   path: '/api/v1/users/:id',
 *   upstream: 'http://user-service:3000',
 *   plugins: [authPlugin, rateLimitPlugin],
 * };
 */
export interface RouteDefinition {
  /** HTTP method this route responds to. */
  method: HttpMethod;

  /**
   * URL path pattern, supporting named parameters (`:param`) and
   * wildcards (`*`) as understood by find-my-way.
   */
  path: string;

  /**
   * The base URL of the upstream service this route proxies to.
   * The incoming request path is appended to this base URL.
   * e.g. upstream 'http://user-service:3000' + path '/api/v1/users/42'
   *      → proxied to 'http://user-service:3000/api/v1/users/42'
   */
  upstream: string;

  /**
   * An optional ordered array of plugin middleware functions executed
   * before the request is forwarded to the upstream service.
   * Plugins run in the order they are declared.
   */
  plugins?: Plugin[];
}

// ---------------------------------------------------------------------------
// Gateway Configuration
// ---------------------------------------------------------------------------

/**
 * Top-level configuration options for the Jaunt Gateway instance.
 */
export interface GatewayOptions {
  /**
   * The port the HTTP server will listen on.
   * @default 3000
   */
  port?: number;

  /**
   * The hostname/IP address the server binds to.
   * @default '0.0.0.0'
   */
  host?: string;

  /**
   * Global plugins applied to every route before route-level plugins.
   * Useful for cross-cutting concerns like request ID injection or
   * global rate limiting.
   */
  globalPlugins?: Plugin[];

  /**
   * Timeout in milliseconds for upstream proxy requests.
   * @default 30000
   */
  proxyTimeout?: number;
}

// ---------------------------------------------------------------------------
// Router Store (internal)
// ---------------------------------------------------------------------------

/**
 * The payload stored in find-my-way's route handler store.
 * This is the data the router hands back when a route is matched,
 * giving the request lifecycle everything it needs to proceed.
 *
 * @internal
 */
export interface RouteStore {
  /** The resolved upstream base URL for this route. */
  upstream: string;

  /** The ordered plugin chain for this specific route. */
  plugins: Plugin[];
}
