// FOUNDATION: Public plugin contract. Changes affect independently built plugins.
import type { Context, Inject } from "@deepseek-ai/cordis";
import type * as React from "react";

// Metadata is readable without executing the plugin.
export type PluginManifest = Readonly<{
  id: string;
  name: string;
  apiVersion: 1;
  description?: string;
  /** Support Git update notices. The user's saved choice overrides this default. */
  updates?: Readonly<{ defaultEnabled: boolean }>;
  /** Author-supplied browsing metadata. It never grants host capabilities. */
  discovery?: Readonly<{
    /** Stable category slug. Hosts may group unrecognized values under Other. */
    category?: string;
    /** Readable tags: 1–80 UTF-8 bytes each, no control characters, at most 16.
     * Duplicate comparison collapses whitespace and uses Unicode lowercase. */
    tags?: readonly string[];
  }>;
  host?: Readonly<{
    /** Observe and influence native hook events for these agent type keys. */
    agentHooks?: readonly string[];
    /** Offer execution targets for these native agent type keys. */
    agentExecution?: readonly string[];
    commands?: readonly Readonly<{
      id: string;
      program: string;
      args: readonly string[];
      /** Opt-in UTF-8 stdin bound, at most 65536 bytes; absent means no input. */
      maxInputBytes?: number;
      /** Maximum UTF-8 stdout bytes; defaults to 4096, bounded at 1048576. */
      maxOutputBytes?: number;
      /** Run an installed executable only when its bytes and declared sibling
       * files match this descriptor, never a program found on PATH. */
      artifact?: Readonly<{
        path: string;
        sha256: string;
        siblings?: readonly Readonly<{ name: string; sha256: string }>[];
      }>;
    }>[];
    networkOrigins?: readonly string[];
    /** Separate authority access; ordinary HTTPS grants never authorize a session. */
    federatedIdentity?: Readonly<{
      authority: string;
      operations: readonly Readonly<{
        method: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
        path: string;
      }>[];
    }>;
    /** Programs the plugin may start with `host.spawn`; the caller's
     * arguments follow the declared ones. */
    processes?: readonly Readonly<{
      id: string;
      program: string;
      args?: readonly string[];
      /** Run the copy the app ships, never one on PATH. */
      bundled?: boolean;
      /** Run an installed executable only when its bytes and declared sibling
       * files match this descriptor. Mutually exclusive with `bundled`. */
      artifact?: Readonly<{
        path: string;
        sha256: string;
        siblings?: readonly Readonly<{ name: string; sha256: string }>[];
      }>;
    }>[];
    /** The plugin may serve MCP with `host.serveMcp`, including tools for
     * commands bound to an Attention source run. */
    mcp?: boolean;
    /** The plugin may read files with `host.readFile` and resolve directories
     * with `host.resolveDirectory`, with the user's own access. */
    files?: boolean;
    /** Pathless temporary saves in host-selected private storage; no read access. */
    managedFiles?: boolean;
    /** `host.requestBytes` may also read raster images from any public HTTPS
     * address, one hop at a time with no cookies, outside `networkOrigins`.
     * Redirects and pages come back without a body. */
    publicImages?: boolean;
    /** `host.readPage` may read the title, description, site name, image
     * and icon a public HTTPS page names in its head, one hop at a time with
     * no cookies. The page itself never comes back. */
    publicPages?: boolean;
  }>;
}>;
// Module evaluation must be pure. apply owns resources through ctx.effect.
// A plugin may contribute to several surfaces, or provide services without UI.
export type PluginModule = {
  // Cordis starts apply only when these services are available.
  inject?: Inject;
  apply: (ctx: Context) => void | Promise<void>;
};

// Installation identity follows child Cordis scopes so services can own contributions.
declare module "@deepseek-ai/cordis" {
  interface Context {
    react: typeof React;
    readonly pluginOwner?: Readonly<{
      id: string;
      revision: string;
      agentHooks?: readonly string[];
      agentExecution?: readonly string[];
    }>;
  }
}

export type {
  FederatedIdentity,
  SessionSnapshot,
  AuthenticatedRequest,
} from "../features/federated-identity/service";
