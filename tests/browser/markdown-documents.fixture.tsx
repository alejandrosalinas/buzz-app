// Every screen that shares the Markdown renderer, each in its own host with
// that host's CSS and the app's fonts, for rendered checks across themes,
// widths and the app's text scale.
import "@fontsource-variable/inter/wght.css";
import "@fontsource-variable/inter/wght-italic.css";
import "@fontsource/jetbrains-mono/400.css";
import { createRoot } from "react-dom/client";
import { PluginReadme } from "../../src/app/PluginReadme";
import { CanvasEditor } from "../../src/bundled/channels/CanvasEditor";
import { CanvasMarkdown } from "../../src/bundled/channels/CanvasView";
import type { ChannelCanvas } from "../../src/features/channel-templates/capability";
import { GitHubBody } from "../../src/bundled/github/GitHubBody";
import { NoteBody } from "../../src/bundled/relay-notes/NotesPage";
import notesStyles from "../../src/bundled/relay-notes/NotesPage.module.css";
import { Body as RepoBody } from "../../src/bundled/repos/RepoPage";
import { InstructionsMarkdown } from "../../src/bundled/watching/InstructionsMarkdown";
import "../../src/bundled/watching/AttentionPage.css";
import { ActivityTranscript } from "../../src/features/agents/ActivityTranscript";
import { activityTranscript } from "../../src/features/agents/activity-transcript";
import { createAgentMemories } from "../../src/features/agents/memory";
import { MemoryPanel } from "../../src/features/agents/MemoryPanel";
import type { Agent } from "../../src/features/agents/service";
import type { RelaySession } from "../../src/features/relay/session";
import { ToastProvider } from "../../src/shared/design-system/ui/Toast";
import "../../src/shared/styles/globals.css";

const SAMPLE = [
  "# Title",
  "## Section",
  "### Topic",
  "#### Detail",
  "Text with `code`, ~~gone~~ and [a link](https://example.com).",
  "- one\n  - two\n    - three",
  "1. first\n2. second",
  "- [x] done",
  "> quoted",
  "---",
  "| a | b |\n| - | - |\n| 1 | 2 |",
  "```\nconst value = 1;\n```",
].join("\n\n");

// A line that cannot wrap, a long reply, and a document too deep to render.
const LONG_LINE = `\`\`\`\n${"abcdefghijklmnopqrstuvwxyz ".repeat(40)}\n\`\`\``;
const LONG_CODE = `\`\`\`\n${Array.from({ length: 60 }, (_, line) => `${line} ${"x".repeat(160)}`).join("\n")}\n\`\`\``;
const TOO_DEEP = `${">".repeat(120)} ${"deep ".repeat(200)}`;

/** A saved Canvas holding content, with no relay behind it. */
function canvasOf(content: string) {
  const event = {
    id: "c".repeat(64),
    pubkey: "d".repeat(64),
    created_at: 1,
    kind: 40100,
    tags: [],
    content,
    sig: "e".repeat(128),
  };
  return {
    available: true,
    read: async () => event,
    save: async () => event,
    history: async () => ({ revisions: [event], next: undefined }),
  } as unknown as ChannelCanvas;
}
const profiles = {
  snapshot: () => new Map(),
  subscribe: () => () => {},
  ensure: async () => {},
};

const params = new URLSearchParams(location.search);
const html = document.documentElement;
html.dataset.colorMode = params.get("mode") ?? "light";
// The app's text scale, as the appearance service sets it.
html.style.setProperty("--buzz-text-scale", params.get("scale") ?? "1");

const agent = "a".repeat(64);
const at = Date.parse("2026-11-04T12:00:00Z");
const frame = (seq: number, kind: string, payload: unknown = {}) => ({
  seq,
  timestamp: new Date(at + seq * 1000).toISOString(),
  kind,
  agentIndex: 0,
  channelId: null,
  sessionId: "S",
  turnId: "t1",
  payload,
});
const reply = (seq: number, text: string, messageId: string) =>
  frame(seq, "acp_read", {
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "S",
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId,
        content: { type: "text", text },
      },
    },
  });
const transcript = activityTranscript(
  [
    {
      id: "1".padStart(64, "0"),
      agent,
      receivedAt: at,
      plaintext: JSON.stringify({
        kind: "batch",
        payload: {
          events: [
            frame(0, "turn_started"),
            reply(1, SAMPLE, "m1"),
            frame(2, "acp_read", {
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                sessionId: "S",
                update: { sessionUpdate: "tool_call", toolCallId: "c1" },
              },
            }),
            reply(3, LONG_CODE, "m2"),
            frame(4, "turn_completed", { outcome: "completed" }),
          ],
        },
      }),
    },
  ],
  { agent },
);

const memories = createAgentMemories(
  async () => ({
    entries: [
      { slug: "core", body: SAMPLE, eventId: "b".repeat(64), createdAt: 1 },
    ],
    partial: false,
  }),
  "c".repeat(64),
  () => true,
);
const memoryAgent = {
  pubkey: agent,
  name: "Ada",
  relay: "wss://current.example",
  place: "here",
} as Agent;

const note = {
  id: "d".repeat(64),
  pubkey: agent,
  created_at: Math.floor(at / 1000),
  kind: 30_023,
  content: SAMPLE,
  tags: [
    ["d", "runbook"],
    ["title", "Runbook"],
  ],
};
const scope = { viewer: agent, communityOrigin: "https://current.example" };

const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(
  <ToastProvider>
    <main
      style={{
        width: Number(params.get("width") ?? 1100),
        padding: 16,
        background: "var(--surface-panel)",
        color: "var(--text-standard)",
      }}
    >
      {/* The real Canvas editor, reading a local Canvas. */}
      <section data-screen="canvas">
        <CanvasEditor
          canvas={canvasOf(SAMPLE)}
          profiles={profiles}
          scope="fixture"
          channelId="11111111-1111-4111-8111-111111111111"
        />
      </section>
      <section data-screen="canvas-host">
        <CanvasEditor
          canvas={canvasOf(LONG_LINE)}
          profiles={profiles}
          scope="fixture"
          channelId="22222222-2222-4222-8222-222222222222"
        />
      </section>
      <section data-screen="canvas-source">
        <CanvasMarkdown content={TOO_DEEP} openLink={() => false} />
      </section>
      <section data-screen="notes" className={notesStyles.page}>
        <NoteBody
          note={note}
          session={undefined as unknown as RelaySession}
          openLink={() => false}
          author="Ada"
        />
      </section>
      <section data-screen="repo" className="repos-page text-body">
        <RepoBody text={SAMPLE} open={async () => {}} scope={scope} />
      </section>
      <section data-screen="memory">
        <MemoryPanel
          agent={memoryAgent}
          memories={memories.capability}
          agents={{ subscribe: () => () => {}, memberships: () => [] }}
        />
      </section>
      <section data-screen="transcript">
        <ActivityTranscript
          transcript={transcript}
          agentName="Ada"
          state={() => "ended"}
          follow={false}
        />
      </section>
      <section data-screen="plugin-readme">
        <PluginReadme text={SAMPLE} />
      </section>
      <section data-screen="github">
        <GitHubBody body={SAMPLE} url="https://github.com/o/r/pull/1" />
      </section>
      <section data-screen="attention" className="attention-page">
        <details className="attention-instructions" open>
          <summary>Instructions</summary>
          <InstructionsMarkdown text={SAMPLE} />
        </details>
      </section>
    </main>
  </ToastProvider>,
);
