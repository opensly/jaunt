/**
 * @file index.ts
 * @description Public entry point for the `jaunt` npm package.
 *
 * Re-exports the full public API surface so consumers can import
 * everything they need from a single top-level path:
 *
 * @example
 * import { Gateway, Router, composePipeline } from 'jaunt';
 * import type { GatewayContext, RouteDefinition, Plugin } from 'jaunt';
 */

export { Gateway } from './Gateway';
export { Router } from './Router';
export { composePipeline } from './pipeline';

export type {
  GatewayContext,
  GatewayOptions,
  RouteDefinition,
  RouteStore,
  Plugin,
  HttpMethod,
} from './types';
