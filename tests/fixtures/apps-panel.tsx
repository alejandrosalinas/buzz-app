import "../../src/shared/styles/globals.css";
import { Context } from "@deepseek-ai/cordis";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { applyApps } from "../../src/bundled/builderlab/apps";
import { createNativeSession } from "../../src/bundled/builderlab/session";
import { BrowserService } from "../../src/features/browser/service";
import type {
  FederatedIdentity,
  SessionSnapshot,
} from "../../src/features/federated-identity/service";
import type { BrowserPlatform } from "../../src/features/browser/platform";
import { PanelsService } from "../../src/features/panels/service";
import { PanelWorkspace } from "../../src/features/panels/PanelWorkspace";
import { IconButton } from "../../src/shared/design-system/ui/IconButton";
import { ArrowUpIcon, GaugeIcon } from "../../src/shared/design-system/icons";
import { Avatar } from "../../src/shared/design-system/ui/Avatar";
import { ProfilePeek } from "../../src/features/profiles/ProfilePeek";

// The native adapter is substituted; Cordis, plugin registration, React view
// identity and the four-guest pool are the production collaborators.
const calls = {
  attached: [] as { id: string; url: string; authenticated: boolean }[],
  detached: [] as string[],
  statuses: [] as { id: string; url: string }[],
  presentations: [] as { id: string; visible: boolean }[],
  profilesOpened: [] as string[],
};
Object.assign(window, { appsPanelCalls: calls });
const pages = new Map<string, string>();
const platform: BrowserPlatform = {
  available: true,
  async attach(url, _bounds, _storage, builderlab) {
    const id = `guest-${calls.attached.length + 1}`;
    calls.attached.push({ id, url, authenticated: Boolean(builderlab) });
    pages.set(id, url);
    return id;
  },
  async setBounds(id, _bounds, visible) {
    calls.presentations.push({ id, visible });
  },
  async navigate(id, url) {
    pages.set(id, url);
  },
  async action() {},
  async status(id) {
    const url = pages.get(id) ?? "";
    calls.statuses.push({ id, url });
    return { url, title: "", loading: false, error: null };
  },
  async detach(id) {
    calls.detached.push(id);
    pages.delete(id);
  },
};
const ctx = new Context();
ctx.provide("pluginStatus", {
  isActive: () => true,
  subscribe: () => () => {},
});
ctx.provide("agents", { addTool() {} });
new BrowserService(ctx, platform);
const panels = new PanelsService(ctx);
// The native NIP-FI session is modeled as signed in; the real Builderlab
// session reads its account from it and derives the viewer session.
const snapshot: SessionSnapshot = {
  status: "signed-in",
  authority: {
    id: "fixture",
    identityOrigin: "https://builderlab.example.test",
    apiBasePath: "/api/goose/",
    signIn: "on-demand",
    organization: null,
    communityHosts: [],
  },
  revision: "fixture:1",
  email: "viewer@example.test",
  failure: null,
  expiresAt: null,
  expiring: false,
};
const identity: FederatedIdentity = {
  apiAvailable: true,
  snapshot: () => snapshot,
  subscribe: () => () => {},
  signIn: async () => snapshot,
  async cancelSignIn() {},
  async signOut() {},
  async request({ method, path }) {
    return method === "GET" && path === "/api/goose/v1/auth/me"
      ? {
          status: 200,
          headers: {},
          body: JSON.stringify({
            subject: "fixture|viewer",
            email: "viewer@example.test",
          }),
        }
      : { status: 404, headers: {}, body: "" };
  },
};
const session = createNativeSession(identity);
// The first attach is the authenticated one: wait for the account read.
await new Promise<void>((resolve) => {
  const signedIn = () => session.snapshot().status === "signed-in";
  if (signedIn()) return resolve();
  const stop = session.subscribe(() => {
    if (!signedIn()) return;
    stop();
    resolve();
  });
});
applyApps(
  ctx.extend({ pluginOwner: { id: "fixture.apps", revision: "one" } }) as never,
  session,
  true,
);
const urls = [1, 2, 3, 4, 5].map(
  (id) => `https://app${id}--bpsites.apps.builderlabstaging.xyz/`,
);
const app = panels.resolve(urls[0] ?? "");
if (!app) throw new Error("App panel did not register");
const AppView = app.component;
function Apps() {
  const [selected, select] = useState(0);
  return (
    <>
      {urls.map((url, index) => (
        <button key={url} type="button" onClick={() => select(index)}>
          Show app {index + 1}
        </button>
      ))}
      <div style={{ position: "relative", height: 400, width: 800 }}>
        {urls.map((url, index) => (
          <section
            key={url}
            aria-label={`App ${index + 1} pane`}
            data-covered={selected === index ? undefined : ""}
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              visibility: selected === index ? "visible" : "hidden",
            }}
          >
            <AppView target={url} close={() => {}} />
          </section>
        ))}
      </div>
    </>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Fixture root unavailable");
function HoverHints() {
  const width = Number(new URLSearchParams(location.search).get("pane-width"));
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `${width}px 500px`,
        height: 400,
      }}
    >
      <PanelWorkspace
        main
        items={[
          {
            id: "conversation",
            label: "Conversation",
            content: (
              <div
                style={{
                  display: "flex",
                  flex: 1,
                  flexDirection: "column",
                  alignItems: "end",
                  justifyContent: "space-between",
                  padding: 16,
                }}
              >
                <ProfilePeek
                  trigger={
                    <button type="button" aria-label="nthilly avatar">
                      <Avatar alt="" fallback="nthilly" />
                    </button>
                  }
                  name="nthilly"
                  picture={undefined}
                  pubkey={"1".repeat(64)}
                  agent={false}
                  session={undefined}
                  channelId="conversation"
                  viewer={"1".repeat(64)}
                  target="buzz://profile/nthilly"
                  onOpen={(target) => {
                    calls.profilesOpened.push(target);
                    return true;
                  }}
                />
                <div style={{ display: "flex" }}>
                  <IconButton
                    aria-label="Model and effort"
                    title="Model, effort, and session controls"
                    icon={<GaugeIcon />}
                  />
                  <IconButton
                    aria-label="Send message"
                    title="Send message"
                    icon={<ArrowUpIcon />}
                  />
                </div>
              </div>
            ),
          },
        ]}
        value="conversation"
        select={() => {}}
      />
      <PanelWorkspace
        items={[
          {
            id: "app",
            label: "App",
            content: <AppView target={urls[0] ?? ""} close={() => {}} />,
          },
        ]}
        value="app"
        select={() => {}}
      />
    </div>
  );
}
createRoot(root).render(
  new URLSearchParams(location.search).has("pane-width") ? (
    <HoverHints />
  ) : (
    <Apps />
  ),
);
