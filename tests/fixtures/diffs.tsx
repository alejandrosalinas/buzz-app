import { ToastProvider } from "../../src/shared/design-system/ui/Toast";
// Local signed fixture through real session history/thread/live owners. No relay writes.
import { Context } from "@deepseek-ai/cordis";
import { useEffect, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { createPluginManager } from "../../src/plugins/manager";
import { bundledPlugins } from "../../src/bundled";
import { ConversationService } from "../../src/features/conversation/service";
import { createRelaySession } from "../../src/features/relay/session";
import { MessageRow } from "../../src/features/messages/MessageRow";
import { ThreadPanel } from "../../src/features/messages/ThreadPanel";
import {
  keypair,
  message,
  metadata,
  roster,
  signed,
  bounds,
} from "../../src/features/relay/testing";
import type { RelayEvent } from "../../src/features/relay/events";
import { useKeyboardFocusVisibility } from "../../src/shared/design-system/useKeyboardFocusVisibility";
import { Button } from "../../src/shared/design-system/ui/Button";
import "../../src/shared/styles/globals.css";

const ctx = new Context();
const plugins = createPluginManager(ctx, {
  bundled: bundledPlugins.filter(
    ({ manifest }) => manifest.id === "buzz.diffs",
  ),
});
const extensions = new ConversationService(ctx);
const viewer = keypair(),
  relay = keypair();
const root = message(viewer, "diffs", "Please review this diff", 1);
const patch = `diff --git a/src/greeting.ts b/src/greeting.ts
index 1234567..abcdef0 100644
--- a/src/greeting.ts
+++ b/src/greeting.ts
@@ -1,3 +1,5 @@
 export function greet(name: string): string {
-  return \`Hello, \${name}\`;
+  const displayName = name.trim() || "crawler";
+
+  return \`Welcome to the dungeon, \${displayName}.\`;
 }
`;
const diff = (time: number, extra: string[][] = [], content = patch) =>
  signed(viewer, {
    kind: 40008,
    content,
    created_at: time,
    tags: [
      ["h", "diffs"],
      [
        "file",
        content.includes("src/Greeting.kt")
          ? "src/Greeting.kt"
          : "src/greeting.ts",
      ],
      ["repo", "https://example.com/repository"],
      ["commit", "abcdef0"],
      [
        "description",
        "Made-up diff for UI preview. No real repository changed.",
      ],
      ...extra,
    ],
  });
const events = [root, diff(2), diff(3, [["e", root.id, "", "reply"]])];
let receive = (_events: readonly RelayEvent[]) => {};
const owner = createRelaySession({
  viewer: viewer.pubkey,
  relayAuthor: relay.pubkey,
  media: () => undefined,
  subscribe(callbacks) {
    receive = callbacks.receive;
    return { update() {}, retry() {}, dispose() {} };
  },
  async query(filters) {
    return filters.flatMap((f) => {
      if (f.kinds?.includes(39002))
        return [roster(relay, "diffs", [viewer.pubkey])];
      if (f.kinds?.includes(39000)) return [metadata(relay, "diffs", "Diffs")];
      const rows = events.filter(
        (e) =>
          (!f.kinds || f.kinds.includes(e.kind)) &&
          (!f.ids || f.ids.includes(e.id)) &&
          (!f["#h"] ||
            e.tags.some(
              ([name, value]) => name === "h" && f["#h"]?.includes(value),
            )) &&
          (!f["#e"] ||
            e.tags.some(
              ([name, value]) => name === "e" && f["#e"]?.includes(value),
            )),
      );
      return f["#h"] && f.kinds?.includes(40008)
        ? [
            ...rows,
            bounds(relay, "diffs", "head", {
              has_more: false,
              next_cursor: null,
            }),
          ]
        : rows;
    });
  },
});
owner.session.channels.ensureList();
owner.session.channels.ensure("diffs");
function Preview() {
  useKeyboardFocusVisibility();
  const [enabled, setEnabled] = useState(true);
  const [thread, setThread] = useState(false);
  const [dark, setDark] = useState(false);
  const rosterState = useSyncExternalStore(
    owner.session.channels.subscribeList,
    owner.session.channels.list,
  );
  useEffect(() => {
    if (rosterState.status === "ready") owner.session.channels.ensure("diffs");
  }, [rosterState]);
  const window = useSyncExternalStore(
    (cb) => owner.session.channels.subscribeWindow("diffs", cb),
    () => owner.session.channels.window("diffs"),
  );
  return (
    <main style={{ padding: "2rem", maxWidth: "75rem", margin: "auto" }}>
      <h1 className="text-heading">Diff message preview</h1>
      <div
        style={{
          display: "flex",
          gap: "1rem",
          flexWrap: "wrap",
          marginBottom: "2rem",
        }}
      >
        <Button
          onClick={() => {
            const next = !enabled;
            void plugins.change(next ? "enable" : "disable", "buzz.diffs");
            setEnabled(next);
          }}
        >
          {enabled ? "Disable" : "Enable"} diff plugin
        </Button>
        <Button onClick={() => setThread(!thread)}>Toggle thread</Button>
        <Button
          onClick={() => {
            const e = diff(events.length + 1);
            events.push(e);
            receive([e]);
          }}
        >
          Receive live diff
        </Button>
        <Button
          onClick={() => {
            const e = diff(
              events.length + 1,
              [],
              `${patch}diff --git a/src/Second.kt b/src/Second.kt\n--- a/src/Second.kt\n+++ b/src/Second.kt\n@@ -1 +1 @@\n-val status = "old"\n+val status = "new"\n`,
            );
            events.push(e);
            receive([e]);
          }}
        >
          Receive multi-file diff
        </Button>
        <Button
          onClick={() => {
            const e = diff(
              events.length + 1,
              [],
              `diff --git a/src/Greeting.kt b/src/Greeting.kt\n--- a/src/Greeting.kt\n+++ b/src/Greeting.kt\n@@ -1,4 +1,5 @@\n class Greeting {\n-  val message = "Hello"\n+  val message = "Welcome"\n+  fun greet(name: String) = "\${message}, \${name}!"\n   // Render this Kotlin in both themes\n }\n`,
            );
            events.push(e);
            receive([e]);
          }}
        >
          Receive Kotlin diff
        </Button>
        <Button
          onClick={() => {
            const e = diff(
              events.length + 1,
              [],
              `diff --git a/long.ts b/long.ts\n--- a/long.ts\n+++ b/long.ts\n@@ -1,40 +1,40 @@\n${Array.from({ length: 40 }, (_, i) => ` line ${i}`).join("\n")}\n`,
            );
            events.push(e);
            receive([e]);
          }}
        >
          Receive long diff
        </Button>
        <Button
          onClick={() => {
            const e = diff(
              events.length + 1,
              [["truncated", "true"]],
              "malformed <script>alert(1)</script> ![image](https://example.com/no.png)",
            );
            events.push(e);
            receive([e]);
          }}
        >
          Receive malformed diff
        </Button>
        <Button
          onClick={() => {
            document.documentElement.dataset.colorMode = dark
              ? "light"
              : "dark";
            setDark(!dark);
          }}
        >
          Toggle theme
        </Button>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: thread
            ? "minmax(0, 1fr) minmax(0, 1fr)"
            : "minmax(0, 1fr)",
          gap: "2rem",
        }}
      >
        <div>
          {window.rows.map((row) => (
            <MessageRow
              key={row.id}
              row={row}
              extensions={extensions}
              profile={{ name: "Fixture Reader" }}
              media={() => undefined}
              onOpenLink={() => false}
              day={false}
              retry={undefined}
            />
          ))}
        </div>
        {thread && (
          <ThreadPanel
            session={owner.session}
            scope="diff-preview"
            messageId={root.id}
            extensions={extensions}
            channelId="diffs"
            channelName="Diffs"
            close={() => setThread(false)}
            onOpenLink={() => false}
          />
        )}
      </div>
    </main>
  );
}
const element = document.getElementById("root");
if (element)
  createRoot(element).render(
    <ToastProvider>
      <Preview />
    </ToastProvider>,
  );
