import { Context } from "@deepseek-ai/cordis";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { PluginRuntime } from "../../src/plugins/runtime";
import { ConversationService } from "../../src/features/conversation/service";
import type { PluginModule } from "../../src/plugins/api";
import type { ChannelMessage } from "../../src/features/relay/contracts";
import type { RelaySession } from "../../src/features/relay/session";
import type { HostPage } from "../../src/features/host/service";
import * as links from "../../src/bundled/links";
import { LinkPreview } from "../../src/bundled/link-previews/LinkPreview";
import { createLoader } from "../../src/bundled/link-previews/loader";
import { previewable } from "../../src/bundled/link-previews/safety";
import channelStyles from "../../src/bundled/channels/Channels.module.css";
import { ToastProvider } from "../../src/shared/design-system/ui/Toast";
import "@fontsource-variable/inter/wght.css";
import "../../src/shared/styles/globals.css";

// Real MessageRow, slot and bundled card; the host page reader is faked.
const pages: Record<string, HostPage> = {
  "https://news.example.com/launch": {
    status: 200,
    preview: {
      siteName: "Example News",
      title: "Buzz ships link previews",
      description:
        "Messages now show a card for each web page they link to, with its title, description and image.",
      image: "https://img.example.com/wide.png",
    },
  },
  "https://short.example.com/x": { status: 301, location: "/docs" },
  "https://short.example.com/docs": {
    status: 200,
    preview: { title: "Docs reached through a redirect" },
  },
  "https://evil.example.com/": {
    status: 302,
    location: "https://router.local/admin",
  },
};
const readPage = async (url: string): Promise<HostPage> => {
  await new Promise((resolve) => setTimeout(resolve, 150));
  return (
    pages[url] ?? {
      status: 200,
      preview: { title: `Page at ${new URL(url).hostname}` },
    }
  );
};
async function png(width: number, height: number) {
  const canvas = new OffscreenCanvas(width, height);
  const draw = canvas.getContext("2d");
  if (draw) {
    const gradient = draw.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, "#5b8def");
    gradient.addColorStop(1, "#c86dd7");
    draw.fillStyle = gradient;
    draw.fillRect(0, 0, width, height);
  }
  const blob = await canvas.convertToBlob({ type: "image/png" });
  return new Uint8Array(await blob.arrayBuffer());
}
const requestBytes = async () => ({
  status: 200,
  headers: { "content-type": "image/png" },
  body: await png(1200, 630),
});
const asked: string[] = [];
const loader = createLoader({
  readPage: (url, options) => {
    asked.push(url);
    return readPage(url, options);
  },
  requestBytes,
});
Object.assign(window, { linkPreviewFixture: { asked } });

const webPreviews: PluginModule = {
  inject: ["conversation"],
  apply(ctx) {
    ctx.conversation.registerLinkPreview({
      id: "web",
      title: "Web page preview",
      matches: (url) => !!previewable(url),
      order: 100,
      component: (props) => <LinkPreview {...props} loader={loader} />,
    });
  },
};
const siteOverride: PluginModule = {
  inject: ["conversation"],
  apply(ctx) {
    ctx.conversation.registerLinkPreview({
      id: "tracker",
      title: "Tracker issues",
      matches: (url) => url.startsWith("https://tracker.example.com/"),
      component: ({ url, open }) => (
        <button type="button" data-tracker-card onClick={open}>
          Tracker issue {new URL(url).pathname.split("/").pop()} · In progress
        </button>
      ),
    });
  },
};
const modules: Record<string, PluginModule> = {
  "buzz.links": links,
  "buzz.link-previews": webPreviews,
  "fixture.tracker": siteOverride,
};
const root = new Context();
const runtime = new PluginRuntime(
  root,
  async (plugin) => modules[plugin.manifest.id] ?? links,
);
const conversation = new ConversationService(root);
const plugin = (id: string, name: string) => ({
  manifest: { id, name, apiVersion: 1 as const },
  enabled: true,
  source: "bundled" as const,
  revision: "1",
  previous: null,
  reloadable: false,
  error: null,
});
function mode(override: boolean, previews: boolean) {
  runtime.reconcile([
    plugin("buzz.links", "Links"),
    ...(previews ? [plugin("buzz.link-previews", "Link previews")] : []),
    ...(override ? [plugin("fixture.tracker", "Tracker")] : []),
  ]);
}
mode(true, true);

const message = (id: string, content: string): ChannelMessage => ({
  id,
  channelId: "test",
  authorId: "a".repeat(64),
  createdAt: 1789290300,
  content,
  mentions: [],
  participants: [],
  attachments: [],
  reactions: [],
  replyCount: 0,
});
const rows = [
  message(
    "one",
    "Big news: https://news.example.com/launch and the tracker issue https://tracker.example.com/issues/42",
  ),
  message(
    "two",
    "Quiet link, no card: <https://quiet.example.com/>. In code: `https://code.example.com/`. Redirected: [docs](https://short.example.com/x). Refused redirect: https://evil.example.com/",
  ),
  message(
    "three",
    "Reading list: https://a.example.org/ https://b.example.org/ https://c.example.org/ https://d.example.org/ https://e.example.org/",
  ),
];
const profiles = new Map([["a".repeat(64), { name: "Morgan" }]]);
const directory = { status: "ready", channels: [] };
const emoji = { status: "ready", entries: [] };
const typing: readonly never[] = [];
const session = {
  messages: {},
  outbox: { supports: () => true },
  emoji: {
    snapshot: () => emoji,
    subscribe: () => () => {},
    ensure: async () => {},
  },
  typing: { snapshot: () => typing, subscribe: () => () => {} },
  presence: {
    status: () => "unknown",
    limited: () => false,
    subscribe: () => () => {},
  },
  channels: {
    list: () => directory,
    subscribeList: () => () => {},
  },
  profiles: {
    snapshot: () => profiles,
    subscribe: () => () => {},
    ensure: async () => {},
  },
  media: () => undefined,
} as unknown as RelaySession;

function Preview() {
  const [opened, setOpened] = useState("No link opened");
  const [override, setOverride] = useState(true);
  const [previews, setPreviews] = useState(true);
  return (
    <main
      className={channelStyles.root}
      style={{
        maxWidth: 760,
        margin: "24px auto",
        padding: 24,
        background: "var(--surface)",
      }}
    >
      <h1>Link previews</h1>
      <div style={{ display: "flex", gap: 8 }}>
        <button
          type="button"
          onClick={() => {
            mode(!override, previews);
            setOverride(!override);
          }}
        >
          {override ? "Disable" : "Enable"} tracker plugin
        </button>
        <button
          type="button"
          onClick={() => {
            mode(override, !previews);
            setPreviews(!previews);
          }}
        >
          {previews ? "Disable" : "Enable"} link previews
        </button>
        <button
          type="button"
          onClick={() => {
            document.documentElement.dataset.colorMode =
              document.documentElement.dataset.colorMode === "dark"
                ? "light"
                : "dark";
          }}
        >
          Toggle theme
        </button>
      </div>
      {rows.map((row) => (
        <conversation.ui.Message
          key={row.id}
          row={row}
          session={session}
          scope={`https://preview.example:${"a".repeat(64)}`}
          profile={{ name: "Morgan" }}
          media={() => undefined}
          onOpenLink={(url) => {
            setOpened(url);
            return true;
          }}
          canOpenLink={() => true}
          day={false}
          retry={undefined}
        />
      ))}
      <p role="status">{opened}</p>
    </main>
  );
}
const mount = document.getElementById("root");
if (!mount) throw new Error("Missing root");
createRoot(mount).render(
  <ToastProvider>
    <Preview />
  </ToastProvider>,
);
