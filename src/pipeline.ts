/**
 * @file pipeline.ts
 * @description Implements the asynchronous "onion" middleware pipeline.
 *
 * The onion model means each plugin wraps the next one:
 *
 *   Plugin A (before) → Plugin B (before) → [proxy] → Plugin B (after) → Plugin A (after)
 *
 * This is achieved by composing an array of Plugin functions into a single
 * callable that threads a `next` function through each layer recursively.
 *
 * This module is intentionally framework-agnostic — it only knows about
 * `GatewayContext` and `Plugin`, making it independently testable.
 */

import type { GatewayContext, Plugin } from './types';

/**
 * Composes an ordered array of plugins into a single executable pipeline.
 *
 * The returned function, when called, will execute each plugin in sequence,
 * passing a `next` callback that advances to the subsequent plugin.
 * The final `next` in the chain is a no-op, representing the "end" of the
 * middleware stack (i.e. the point where the proxy call happens externally).
 *
 * @param plugins - Ordered array of middleware functions to compose.
 * @returns A single async function that runs the full pipeline for a given context.
 *
 * @example
 * const run = composePipeline([loggerPlugin, authPlugin]);
 * await run(ctx);
 */
export function composePipeline(
  plugins: Plugin[]
): (ctx: GatewayContext) => Promise<void> {
  return function execute(ctx: GatewayContext): Promise<void> {
    // `index` tracks which plugin is currently executing.
    // It is captured in closure so each call to `execute` has its own counter.
    let index = -1;

    /**
     * Dispatches execution to the plugin at position `i`.
     * Throws if `next()` is called more than once within a single plugin,
     * which would indicate a bug in that plugin's implementation.
     */
    function dispatch(i: number): Promise<void> {
      // Guard against a plugin calling next() multiple times.
      if (i <= index) {
        return Promise.reject(
          new Error('next() called multiple times in the same plugin')
        );
      }

      index = i;

      // Past the end of the plugin array — we've reached the "core" of the
      // onion. Return a resolved promise so the innermost plugin's `await next()`
      // completes cleanly. The actual proxy call is made by Gateway.ts after
      // this pipeline resolves.
      if (i >= plugins.length) {
        return Promise.resolve();
      }

      const plugin = plugins[i];

      // Should never happen given the bounds check above, but satisfies
      // TypeScript's noUncheckedIndexedAccess rule.
      if (!plugin) {
        return Promise.resolve();
      }

      try {
        // Invoke the plugin, providing a bound `next` that advances the index.
        return Promise.resolve(plugin(ctx, () => dispatch(i + 1)));
      } catch (err) {
        return Promise.reject(err as Error);
      }
    }

    return dispatch(0);
  };
}
