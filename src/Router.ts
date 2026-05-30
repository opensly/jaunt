/**
 * @file Router.ts
 * @description A thin, strongly-typed wrapper around the `find-my-way` Radix-tree
 * router. Responsible solely for route registration and URL matching — it has
 * no knowledge of proxying or middleware execution.
 *
 * Keeping routing isolated here makes it trivial to swap the underlying router
 * implementation in the future without touching the rest of the gateway.
 */

import FindMyWay, { type HTTPMethod, HTTPVersion } from 'find-my-way';
import type { IncomingMessage } from 'node:http';
import type { RouteDefinition, RouteStore } from './types';

/**
 * The result returned when a URL is successfully matched against the
 * registered route table.
 */
export interface MatchResult {
  /** The data stored when the route was registered (upstream + plugins). */
  store: RouteStore;

  /**
   * Named path parameters extracted from the URL.
   * e.g. route '/users/:id' matched against '/users/42' → { id: '42' }
   */
  params: Record<string, string>;
}

/**
 * Router wraps `find-my-way` and exposes a minimal API for:
 *  1. Registering route definitions.
 *  2. Matching incoming requests against the route table.
 *
 * It is intentionally stateless beyond the internal find-my-way instance,
 * making it safe to share across async contexts.
 */
export class Router {
  /**
   * The underlying find-my-way router instance.
   * Typed with HTTPVersion.V1 (standard HTTP/1.1 — what Node's native http
   * module uses). The RouteStore payload is attached per-route and retrieved
   * via a cast on match, since find-my-way's generic parameter controls the
   * HTTP version, not the store shape.
   */
  private readonly fmw: ReturnType<typeof FindMyWay<HTTPVersion.V1>>;

  constructor() {
    this.fmw = FindMyWay<HTTPVersion.V1>({
      // Return null instead of throwing when no route is found —
      // the gateway handles 404 responses itself.
      defaultRoute: undefined,

      // Case-sensitive matching keeps route semantics predictable and
      // avoids ambiguity in REST APIs.
      caseSensitive: true,

      // Allow routes with and without trailing slashes to coexist.
      ignoreTrailingSlash: false,
    });
  }

  /**
   * Registers a single route definition into the Radix tree.
   *
   * The `RouteStore` payload (upstream + plugins) is attached to the route
   * so it can be retrieved instantly on match without any additional lookups.
   *
   * @param route - The fully-described route to register.
   * @throws If find-my-way rejects the route (e.g. duplicate path/method).
   */
  public add(route: RouteDefinition): void {
    const store: RouteStore = {
      upstream: route.upstream,
      // Default to an empty array so downstream code never has to null-check.
      plugins: route.plugins ?? [],
    };

    // find-my-way expects its own HTTPMethod type; we cast from our union.
    this.fmw.on(route.method as HTTPMethod, route.path, () => {}, store);
  }

  /**
   * Attempts to match an incoming request against the registered route table.
   *
   * @param req - The native Node.js IncomingMessage.
   * @returns A `MatchResult` if a route was found, or `null` if no match.
   */
  public match(req: IncomingMessage): MatchResult | null {
    const method = req.method ?? 'GET';
    const url = req.url ?? '/';

    const result = this.fmw.find(method as HTTPMethod, url);

    if (!result) {
      return null;
    }

    // find-my-way returns params as Record<string, string | undefined>.
    // We normalise to Record<string, string> by filtering out undefined values,
    // keeping the GatewayContext contract clean.
    const params: Record<string, string> = {};
    for (const [key, value] of Object.entries(result.params)) {
      if (value !== undefined) {
        params[key] = value;
      }
    }

    return {
      store: result.store as RouteStore,
      params,
    };
  }

  /**
   * Returns a human-readable representation of all registered routes.
   * Useful for startup logging and debugging.
   */
  public prettyPrint(): string {
    return this.fmw.prettyPrint();
  }
}
