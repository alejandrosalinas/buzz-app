// Builderlab Apps for local agents: tools that create, deploy and share a
// web app with the plugin's Builderlab sign-in, and a side panel that
// shows a deployed app in Buzz's browser view.
import { createElement, useSyncExternalStore } from "react";
import type { PluginModule } from "../../../plugins/api";
import type { PanelProps } from "../../../features/panels/service";
import type { Host } from "../../../features/host/service";
import type { BuilderlabSession } from "../session";
import {
  createAppsClient,
  federatedTransport,
  type Audience,
  type RuntimeProfile,
} from "./client";
import {
  appName,
  controlPlane,
  isAppUrl,
  isViewerTarget,
  viewerAppDomain,
} from "./environment";

import { Login } from "../login/Login";

type Ctx = Parameters<PluginModule["apply"]>[0];
/** How long `apps_deploy` waits for the new version to serve. */
const READY_WAIT_MS = 120_000;
const READY_POLL_MS = 500;
const positive = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;

const string = (args: Record<string, unknown>, name: string) => {
  const value = args[name];
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${name} is required`);
  return value.trim();
};
/** The compatibility date a live static deploy has used; a newer one may be
 * rejected. */
const COMPATIBILITY_DATE = "2026-08-14";

const DEPLOY_RECIPE = `Deploy a Builderlab app. Read apps_contract before choosing a runtime; creating apps requires the signed-in workspace's Builderlab access (including the server's bb-public early-preview gate). Steps:
1. apps_create once per app, selecting static or fetch-js from the contract. Preserve its app_id and returned manifest.
2. Write the returned manifest as hotpod.manifest.json at the build directory root. For static, put the built site in public/index.html. For fetch-js, write the returned assets_manifest as assets-manifest.json and implement server/index.mjs with a default-exported { async fetch(request, env, ctx) { return new Response("..."); } } handler; its imports must all be in the archive. The returned ASSETS and HOTPOD bindings are required. Do not add hosted tool capabilities in this workflow.
3. Package it with the manifest at the archive root: tar -C <build-dir> -czf <build-dir>/../artifact.tar.gz .
4. Call this with the archive's absolute path; it must be in your owner's home directory.
It returns the version/deployment IDs once accepted, even if readiness checking fails. Use apps_status for that exact version; do not redeploy to retry readiness. Redeploy the same app_id after source changes; a validation error names what to fix in the archive.`;

export function applyApps(
  ctx: Ctx,
  session: BuilderlabSession,
  /** Whether Settings can sign in; otherwise the app's own browser login is used. */
  loginAvailable: boolean,
  /** The development broker's Apps calls; otherwise they go through the
   * native NIP-FI forwarder, which holds the session. */
  dev?: Pick<Host, "request" | "upload">,
) {
  // Cordis wraps service functions on access; keep React's component identity.
  const View = ctx.browser.View;
  const AppView = ({ target }: PanelProps) => {
    const state = useSyncExternalStore(
      session.subscribe,
      session.snapshot,
      session.snapshot,
    );
    // Unconfigured login and other tenants keep their own browser login.
    // Only this build's exact app tenant may receive the Settings credential.
    if (!loginAvailable || (viewerAppDomain() && !isViewerTarget(target)))
      return createElement(View, {
        url: target,
        storage: "builderlab-apps",
        label: appName(target),
      });
    if (state.status !== "signed-in")
      return createElement(
        "div",
        { className: "p-panel-inset" },
        createElement(Login, {
          session,
          cancelOnUnmount: false,
          available: true,
          active: () => true,
        }),
      );
    return createElement(View, {
      url: target,
      builderlab: session.viewerSession(),
      canResumeUrl: viewerAppDomain() ? isViewerTarget : undefined,
      label: appName(target),
    });
  };
  ctx.panels.register({
    id: "app",
    title: "App",
    keepOpen: true,
    matches: (target) => ctx.browser.available && isAppUrl(target),
    component: AppView,
  });
  const base = controlPlane();
  if (!base) return;
  const apps = () =>
    createAppsClient(
      session,
      base,
      dev ?? federatedTransport(ctx.federatedIdentity, base),
    );
  const reply = (value: unknown) => JSON.stringify(value, null, 2);
  ctx.agents.addTool({
    name: "apps_contract",
    description:
      "Read this tenant's Apps Platform contract, supported runtimes, schema location, client requirements and readiness policy before building. This does not grant app or workspace access.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    call: async () => reply(await apps().contract()),
  });
  ctx.agents.addTool({
    name: "apps_create",
    description:
      "Create a new Builderlab app in your owner's authorized workspace. Read apps_contract first, then choose static or fetch-js. Returns the exact app_id, URL and manifest; then follow apps_deploy. Create once per app, not per deploy. If creation partially fails, preserve its app_id and inspect/resume it rather than creating a replacement.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "A short display name." },
        runtime_profile: {
          type: "string",
          enum: ["static", "fetch-js"],
          description:
            "A runtime advertised by apps_contract. Defaults to static.",
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
    async call(_client, _context, args) {
      const profile = (args.runtime_profile ?? "static") as RuntimeProfile;
      if (profile !== "static" && profile !== "fetch-js")
        throw new Error("runtime_profile must be static or fetch-js");
      const created = await apps().create(string(args, "name"), profile);
      return reply({
        ...created,
        manifest: {
          schema: "hotpod.manifest.v1",
          app: { app_id: created.app_id },
          version: { version_id: null, compatibility_date: COMPATIBILITY_DATE },
          ...(profile === "static"
            ? {
                runtime: {
                  profile: "static",
                  root: "public",
                  not_found_handling: "404",
                },
              }
            : {
                runtime: { profile, entrypoint: "server/index.mjs" },
                assets: {
                  binding: "ASSETS",
                  manifest_path: "assets-manifest.json",
                },
                bindings: [
                  {
                    name: "ASSETS",
                    type: "static_assets",
                    resource_ref: "local-artifact",
                    permissions: ["read"],
                  },
                  {
                    name: "HOTPOD",
                    type: "runtime_metadata",
                    permissions: ["read"],
                  },
                ],
              }),
        },
        ...(profile === "fetch-js"
          ? { assets_manifest: { schema: "hotpod.assets.v1", assets: [] } }
          : {}),
      });
    },
  });
  ctx.agents.addTool({
    name: "apps_deploy",
    description: DEPLOY_RECIPE,
    inputSchema: {
      type: "object",
      properties: {
        app_id: { type: "string" },
        artifact: {
          type: "string",
          description: "The absolute path of artifact.tar.gz.",
        },
      },
      required: ["app_id", "artifact"],
      additionalProperties: false,
    },
    async call(_client, _context, args) {
      const id = string(args, "app_id");
      const operation = apps();
      const contract = await operation.contract();
      const policy = contract.readiness as Record<string, unknown> | undefined;
      const deployed = await operation.deploy(id, string(args, "artifact"));
      const version =
        typeof deployed.version_id === "string" ? deployed.version_id : "";
      const result = {
        app_id: id,
        version_id: version,
        deployment_id: deployed.deployment_id,
        rollout_id: deployed.rollout_id,
        external_url: deployed.external_url,
      };
      if (!version) return reply({ ...result, ready: false, deployed });
      const until =
        Date.now() + positive(policy?.default_timeout_ms, READY_WAIT_MS);
      for (;;) {
        let ready: Record<string, unknown>;
        try {
          ready = await operation.ready(
            id,
            version,
            typeof result.deployment_id === "string"
              ? result.deployment_id
              : undefined,
            typeof result.rollout_id === "string"
              ? result.rollout_id
              : undefined,
          );
        } catch (error) {
          return reply({
            ...result,
            ready: false,
            readiness_error:
              error instanceof Error
                ? error.message
                : "Readiness request failed",
            note: "Deployment was accepted. Check this exact version with apps_status; do not redeploy to retry readiness.",
          });
        }
        if (ready.ready === true) return reply({ ...result, ready: true });
        if (
          (Array.isArray(policy?.terminal_statuses) &&
            policy.terminal_statuses.includes(ready.status)) ||
          ready.status === "callback_timeout" ||
          Date.now() >= until
        )
          return reply({
            ...result,
            ready: false,
            note: "Deployment was accepted but is not ready. Inspect readiness diagnostics and check this exact version with apps_status; do not redeploy to retry readiness.",
            readiness: ready,
          });
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            positive(policy?.default_interval_ms, READY_POLL_MS),
          ),
        );
      }
    },
  });
  ctx.agents.addTool({
    name: "apps_status",
    description:
      "Check an accepted deployment's exact version without creating or deploying anything. Use after a readiness timeout or error.",
    inputSchema: {
      type: "object",
      properties: {
        app_id: { type: "string" },
        version_id: { type: "string" },
        deployment_id: { type: "string" },
        rollout_id: { type: "string" },
      },
      required: ["app_id", "version_id"],
      additionalProperties: false,
    },
    call: async (_client, _context, args) =>
      reply(
        await apps().ready(
          string(args, "app_id"),
          string(args, "version_id"),
          typeof args.deployment_id === "string"
            ? args.deployment_id
            : undefined,
          typeof args.rollout_id === "string" ? args.rollout_id : undefined,
        ),
      ),
  });
  ctx.agents.addTool({
    name: "apps_list",
    description: "List the Builderlab apps your owner owns, with their URLs.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    call: async () => reply(await apps().list()),
  });
  const communities = (access: Record<string, unknown>) =>
    Array.isArray(access.shared_community_ids)
      ? access.shared_community_ids.filter((id) => typeof id === "string")
      : [];
  ctx.agents.addTool({
    name: "apps_visibility",
    description:
      "Choose who can open an app: everyone in your owner's workspace (the default for new apps) or only your owner. Communities it is shared with keep access either way. Only when asked.",
    inputSchema: {
      type: "object",
      properties: {
        app_id: { type: "string" },
        audience: { type: "string", enum: ["workspace", "only_you"] },
      },
      required: ["app_id", "audience"],
      additionalProperties: false,
    },
    async call(_client, _context, args) {
      const audience = string(args, "audience") as Audience;
      if (audience !== "workspace" && audience !== "only_you")
        throw new Error("audience must be workspace or only_you");
      const id = string(args, "app_id");
      const access = await apps().visibility(id, audience);
      const shared = communities(access);
      const others = Array.isArray(access.effective_viewers)
        ? access.effective_viewers.filter((viewer) => viewer !== access.owner)
            .length
        : 0;
      return reply({
        app_id: id,
        audience,
        shared_community_ids: shared,
        who_can_open: [
          audience === "workspace"
            ? "Everyone in your owner's workspace."
            : "Only your owner.",
          ...(audience === "only_you" && others
            ? [
                `${others} ${others === 1 ? "other person" : "other people"} can also open it.`,
              ]
            : []),
          ...(shared.length
            ? [
                `So can members of the ${shared.length === 1 ? "Buzz community" : `${shared.length} Buzz communities`} it is shared with.`,
              ]
            : []),
        ].join(" "),
      });
    },
  });
  ctx.agents.addTool({
    name: "apps_community",
    description:
      "Share an app with a Buzz community your owner belongs to, or stop sharing it. Its members can then open the app whatever its visibility. Only when asked.",
    inputSchema: {
      type: "object",
      properties: {
        app_id: { type: "string" },
        community_id: {
          type: "string",
          description: "The Buzz community's Builderlab ID.",
        },
        action: { type: "string", enum: ["grant", "revoke"] },
      },
      required: ["app_id", "community_id", "action"],
      additionalProperties: false,
    },
    async call(_client, _context, args) {
      const action = string(args, "action");
      if (action !== "grant" && action !== "revoke")
        throw new Error("action must be grant or revoke");
      const id = string(args, "app_id");
      const community = string(args, "community_id");
      const shared = communities(await apps().community(id, community, action));
      return reply({
        app_id: id,
        community_id: community,
        shared: shared.includes(community),
        shared_community_ids: shared,
      });
    },
  });
  ctx.agents.addTool({
    name: "apps_open",
    description:
      "Open a deployed app beside this conversation in your owner's Buzz, when they are viewing it. Use it after a deploy is ready, and still post the URL in your reply.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The app's external URL." },
      },
      required: ["url"],
      additionalProperties: false,
    },
    async call(_client, context, args) {
      const url = string(args, "url");
      if (!isAppUrl(url)) throw new Error("That is not a Builderlab app URL");
      if (!context.channel)
        throw new Error("There is no conversation to open it beside");
      const opened = ctx.panels.requestOpen({
        target: url,
        channelId: context.channel,
        ...(context.root ? { rootId: context.root } : {}),
      });
      return opened
        ? "Opened beside the conversation."
        : "Not opened: your owner is not viewing this conversation in the desktop app now. Post the URL; clicking it opens the app beside the conversation.";
    },
  });
}
