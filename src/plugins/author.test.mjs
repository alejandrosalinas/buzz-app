import { test, expect } from "vitest";
import { mkdtemp, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

test("generated author package exposes shared messages, captured-read Undo, host, identity names, agent sessions, decisions, and page navigation metadata", async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const dir = await mkdtemp(join(tmpdir(), "buzz-author-consumer-"));
  const env = {
    ...process.env,
    PATH: `${resolve(root, "bin")}:${process.env.PATH}`,
  };
  const run = (command, args) => {
    const result = spawnSync(command, args, {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  };
  try {
    await symlink(
      resolve(root, "node_modules"),
      join(dir, "node_modules"),
      "dir",
    );
    run("node", ["scripts/build-author.mjs", join(dir, "author package")]);
    await writeFile(
      join(dir, "consumer.ts"),
      `
import { createElement } from "react";
import type { Context, DocumentEditorProps, DocumentEditorHandle, DocumentEditorSelection, ChannelMembersDialogProps, ChannelGeneralAccessProps, GeneralAccessPolicy, MemberChange, Delivery, HarnessConversation, McpHandler, StandaloneTurn, TurnResult, DecisionResult, Host, HostRequestOnceOptions, AddedTool, AddedToolContext, AddedToolReply, BuzzClient, Media, HostByteUpload, HostByteRequest, HostByteResponse, HostSavedBytes, NetworkDiagnostics, NetworkDiagnosticsSnapshot, NetworkCaptureReset, NetworkLogLevel, PluginManifest, NamingPolicy, PagePreviewProps, PageSidebarProps, SidebarSectionContribution, SidebarSections, SidebarRowContribution, SidebarRows, ReadMutationResult, UnreadCapability, Backdrops, PluginUi, Seen } from "@buzz/author";
export const manifest: PluginManifest = {
  id: "example.plugin", name: "Example", apiVersion: 1,
  host: {
    commands: [{ id: "status", program: "example-cli", args: ["status"], maxOutputBytes: 65536 }],
    networkOrigins: ["https://api.example.com"],
    managedFiles: true,
    publicImages: true,
    publicPages: true,
  },
};
const ExampleSidebar = ({ target, children }: PageSidebarProps) => {
  void target.kind;
  return children;
};
const ExamplePreview = ({ close }: PagePreviewProps) =>
  createElement("button", { type: "button", onClick: close }, "Open");
export const inject = ["agents", "decisions", "host", "identityNames", "pages", "relay"];
export function apply(ctx: Context) {
  const diagnostics: NetworkDiagnostics | undefined = ctx.reflect.get("networkDiagnostics");
  if (diagnostics?.version === 1) {
    const reset: NetworkCaptureReset = { enabled: false, minutes: 15 };
    const level: NetworkLogLevel = "debug";
    const snapshot: NetworkDiagnosticsSnapshot = diagnostics.snapshot();
    void [snapshot.events, snapshot.metrics?.relays, snapshot.archive?.path];
    ctx.effect(() => {
      void diagnostics.setEnabled(true);
      return () => diagnostics.setEnabled(false);
    });
    void diagnostics.setLevel(level);
    void diagnostics.setAutoReset(reset);
    // @ts-expect-error Unsupported capture levels must not reach the host.
    diagnostics.setLevel("verbose");
    // @ts-expect-error The capability version is host-owned.
    diagnostics.version = 2;
  }
  const seen: Seen | undefined = ctx.reflect.get("seen");
  const key = "example.plugin/welcome";
  if (seen?.has(key) === false) seen.mark(key);
  const sharingPolicy: GeneralAccessPolicy = { subject: "record", allowPublic: false, visibilityDescription: () => "Record access changes." };
  const general: ChannelGeneralAccessProps = { capability: ctx.relay.snapshot().session.channelDetails, channelId: "record", policy: sharingPolicy };
  const picker: ChannelMembersDialogProps = { session: ctx.relay.snapshot().session, channelId: "record", trigger: { current: null }, close() {},
    nonMemberLabel: "Not in this record",
    memberActions: { canAdd: true, pending: false, async change(change: MemberChange, signal: AbortSignal) { void [change.expectedRole, signal.aborted]; } },
    accessSettings: createElement(ctx.conversation.ui.GeneralAccess, general), shareLink: "buzz://plugin?id=example.plugin" };
  createElement(ctx.conversation.ui.MembersDialog, picker);
  type HostPickerKeys = "agents" | "communities" | "navigator" | "signal" | "visit" | "canOpenLink" | "onOpenLink" | "onOpenMessage";
  const pickerHasNoHostProps: Extract<keyof ChannelMembersDialogProps, HostPickerKeys> extends never ? true : false = true;
  void pickerHasNoHostProps;
  // @ts-expect-error Host navigation visits are not plugin props.
  createElement(ctx.conversation.ui.MembersDialog, { ...picker, visit: true });
  const editorRef: { current: DocumentEditorHandle | null } = { current: null };
  const selection: DocumentEditorSelection = { start: 0, end: 1, source: false };
  const editor: DocumentEditorProps = { ref: editorRef, value: "**Hello**", onChange(value) { void value.length; }, editing: true, source: false, onSourceChange() {}, linkOpen: false, onLinkOpenChange() {}, onSave() {}, maxLength: 32768, destinations: [{label: "Reference", href: "buzz://plugin?id=example.plugin"}] };
  createElement(ctx.conversation.ui.DocumentEditor, editor);
  editorRef.current?.focusSelection(selection);
  // @ts-expect-error Source mode must be controlled with a boolean.
  const invalidEditor: DocumentEditorProps = { ...editor, source: "Markdown" };
  void invalidEditor;
  const ui: PluginUi | undefined = ctx.reflect.get("ui");
  if (ui) {
    void createElement(ui.Dialog, { open: true, onOpenChange: (open: boolean) => void open, title: "Edit",
      actions: createElement(ui.Button, { variant: "prominent", onClick: () => {} }, "Save") },
      createElement(ui.Field, { label: "Name" }, createElement(ui.Input, { onValueChange: (value: string) => void value })));
    void createElement(ui.Switch, { label: "Alerts", onCheckedChange: (checked: boolean) => void checked });
    // @ts-expect-error Internal and legacy variants are not part of the plugin contract.
    void createElement(ui.Button, { variant: "glass", children: "Glass" });
  }
  const unread: UnreadCapability = ctx.relay.snapshot().session.unread;
  const conversations: ReturnType<UnreadCapability["inbox"]> = unread.inbox();
  if (unread.markCapturedMessagesRead) {
    const capturedRead: Promise<ReadMutationResult> =
      unread.markCapturedMessagesRead(["example-message-id"]);
    void capturedRead.then(({ undo }) => undo?.());
  }
  for (const item of conversations.items) {
    for (const message of item.messages) {
      const id: string = message.id;
      const createdAt: number = message.createdAt;
      const mentioned: boolean = message.mentioned;
      void [id, createdAt, mentioned];
      // @ts-expect-error Shared message facts are immutable.
      message.mentioned = false;
    }
    // @ts-expect-error The shared projection does not expose Archive policy.
    item.archived;
  }
  for (const type of ctx.agents.types())
    for (const session of type.sessions?.list("") ?? [])
      void [session.channelId, session.root, session.at, session.status];
  const policy: NamingPolicy = {
    id: "alternative",
    resolve: (identities) => new Map(identities.map(({ pubkey, name }) => [pubkey, { name }])),
  };
  ctx.identityNames.register(policy);
  const host: Host = ctx.host;
  const upload: HostByteUpload = { url: "https://api.example.com/upload", field: "image", name: "image.png", contentType: "image/png" };
  void host.uploadBytesOnce?.(new Uint8Array([1]), upload, { callId: crypto.randomUUID() });
  const tool: AddedTool = { name: "example_image", description: "Read an image", inputSchema: {},
    async call(client: BuzzClient, context: AddedToolContext): Promise<AddedToolReply> {
      void [context.channel, context.root, context.topLevel, context.wholeChannel];
      const media: Media = await client.media("abc.png");
      return media.data ?? "No inline image";
    },
  };
  ctx.agents.addTool(tool);
  const { harness } = ctx.agents;
  ctx.agents.register({
    id: "example",
    title: "Example",
    defaults: () => ({ config: {} }),
    async run(delivery: Delivery) {
      const conversation: HarnessConversation | undefined = await harness.conversation(delivery, "thread");
      if (!conversation) return delivery.ignored?.();
      void [conversation.key, conversation.channel, conversation.root, conversation.topLevel, conversation.where];
      const system: string = await harness.systemPrompt(delivery, { scope: "thread", cwd: "~", instructions: "", tools: false });
      const first = await harness.turnPrompt(delivery, conversation);
      const prompt = await harness.turnPrompt(delivery, conversation, { cursor: first.cursor });
      const next: string = prompt.cursor;
      const tools: McpHandler = harness.tools(delivery.agent, conversation, { read: async () => new Uint8Array() });
      void host.serveMcp?.(tools);
      void [system, prompt.text, next];
      prompt.restore();
      await harness.reply(delivery.agent, conversation, "Done", { notifyOwner: true });
    },
    async runOnce(turn: StandaloneTurn): Promise<TurnResult> {
      const text = await turn.prompt();
      if (text !== undefined) void harness.standalonePrompt(turn.delivery.agent, text);
      void harness.tools(turn.delivery.agent);
      return { ok: true };
    },
  });
  void host.runCommand("status").then((output: string | null) => void output);
  void host.request({
    url: "https://api.example.com/graphql",
    method: "POST",
    headers: { Authorization: "Bearer sample" },
    body: "{}",
  }).then((response) => void response.status);
  // Final synchronous eligibility is part of the optional protected method.
  if (typeof host.requestOnce === "function") {
    const options: HostRequestOnceOptions = {
      callId: "12345678-1234-4234-8234-123456789abc",
      isEligible: () => true,
    };
    void host.requestOnce({ url: "https://api.example.com/submit", method: "POST" }, options);
    // @ts-expect-error Final caller eligibility must be synchronous.
    const invalid: HostRequestOnceOptions = { callId: options.callId, isEligible: async () => true };
    void invalid;
  }
  const bytes: HostByteRequest = { url: "https://api.example.com/bytes", maxBytes: 1024 };
  void host.requestBytes?.(bytes).then((response: HostByteResponse) => {
    const body: Uint8Array = response.body;
    void host.saveBytes?.(body, { sha256: "0".repeat(64), releaseAfterSend: true }).then((saved: HostSavedBytes) => {
      const acknowledged: true | undefined = saved.releaseAfterSend;
      void [saved.path, saved.size, saved.sha256, saved.expiresAt, acknowledged];
    });
  });
  // @ts-expect-error Byte GET has no caller headers.
  host.requestBytes?.({ ...bytes, headers: {} });
  // @ts-expect-error Release policy must be a boolean, not a callback.
  host.saveBytes?.(new Uint8Array([1]), { sha256: "0".repeat(64), releaseAfterSend: () => true });
  // @ts-expect-error Managed save has no caller account.
  host.saveBytes?.(new Uint8Array([1]), { sha256: "0".repeat(64), owner: "caller supplied" });
  // @ts-expect-error Managed save has no caller path.
  host.saveBytes?.(new Uint8Array([1]), { sha256: "0".repeat(64), path: "/chosen" });
  ctx.pages.register({
    id: "main",
    title: "Example",
    component: () => null,
    icon: "data:image/png;base64,iVBOR",
    primary: true,
    placement: "toolbar",
    sidebar: ExampleSidebar,
    preview: ExamplePreview,
  });
  ctx.pages.register({
    id: "bad-preview",
    title: "Bad preview",
    component: () => null,
    // @ts-expect-error A page preview must be a React component.
    preview: "card",
  });
  ctx.pages.register({
    id: "bad-sidebar",
    title: "Bad sidebar",
    component: () => null,
    // @ts-expect-error A page sidebar must be a React component.
    sidebar: 1,
  });
  const section: SidebarSectionContribution = {
    version: 1,
    id: "work",
    title: "Work",
    icon: "W",
    rows: {
      snapshot: () => [{ id: "today", label: "Today" }],
      subscribe: () => () => {},
    },
    select: () => ({ version: 1, kind: "home" }),
    actions: [{ id: "new", label: "New", icon: createElement("span"), onSelect: () => {} }],
  };
  const backdrops: Backdrops | undefined = ctx.reflect.get("backdrops");
  backdrops?.register({ id: "glow", component: () => null });
  // @ts-expect-error A backdrop must be a React component.
  backdrops?.register({ id: "bad-glow", component: "div" });
  const sidebar: SidebarSections | undefined = ctx.reflect.get("sidebarSections");
  sidebar?.register(section);
  // @ts-expect-error Sidebar contribution versions are explicit.
  sidebar?.register({ ...section, version: 2 });
  // @ts-expect-error Row counts are numeric, not display text.
  const badCount: SidebarSectionContribution = { ...section, rows: { snapshot: () => [{ id: "bad", label: "Bad", count: "two" }], subscribe: () => () => {} } };
  void badCount;
  const hostRows: SidebarRows | undefined = ctx.reflect.get("sidebarRows");
  const decoration: SidebarRowContribution = {
    version: 1, id: "details",
    render: (row, Default) => row.kind === "dm" ? createElement("div", { title: row.label }, Default) : Default,
    sortModes: [{ id: "reverse", label: "Reverse", compare: (a, b) => b.label.localeCompare(a.label) }],
  };
  hostRows?.register(decoration);
  // @ts-expect-error Host row contribution versions are explicit.
  hostRows?.register({ ...decoration, version: 2 });
  // @ts-expect-error Render results must be elements or an intentional null.
  hostRows?.register({ version: 1, id: "invalid", render: () => "text" });
  ctx.pages.register({
    id: "other",
    title: "Other",
    component: () => null,
    // @ts-expect-error A page icon is a data URL string.
    icon: 1,
  });
  for (const placement of ["sidebar", "dock", "topbar", "toolbar"] as const)
    ctx.pages.register({ id: placement, title: placement, component: () => null, primary: true, placement });
  ctx.pages.register({
    id: "bad-placement", title: "Bad placement", component: () => null,
    // @ts-expect-error A placement must name a supported navigation location.
    placement: "floating",
  });
  // @ts-expect-error Programs must be declared in the manifest, not supplied at runtime.
  host.runCommand("example-cli", ["status"]);
  void ctx.decisions
    .decide({
      state: "The build is broken on main.",
      questions: {
        urgent: { type: "yes_no", instructions: "It needs attention now." },
        topic: { type: "choice", instructions: "Topic", options: { build: "CI", other: "Other" } },
        severity: { type: "score", instructions: "Severity", levels: ["low", "high"] },
      },
      timeoutMs: 5000,
    })
    .then((result: DecisionResult) => {
      if (result.outcome === "failed") return void result.reason;
      const answer = result.answers.urgent;
      if (answer?.type === "yes_no") void answer.probability;
      void [result.backend, result.model];
    });
  void ctx.decisions.decide({
    state: "x",
    // @ts-expect-error A question needs a supported type.
    questions: { bad: { type: "freeform", instructions: "x" } },
  });
  void ctx.decisions.backend();
  ctx.decisions.retireProvider("retired");
  // @ts-expect-error Only Settings chooses the backend.
  ctx.decisions.setBackend("typesafe");
}
// @ts-expect-error Host construction is not exported to plugin authors.
import type { createServices } from "@buzz/author";
`,
    );
    await writeFile(
      join(dir, "document-consumer.ts"),
      `
import type { Context, MarkdownProps, PanelWorkspaceItem, PanelWorkspaceProps, PanelSplit } from "@buzz/author";
export const inject = ["react", "conversation", "panels"];
export function apply(ctx: Context) {
  const React = ctx.react;
  const document: MarkdownProps = { content: "**Hello**", scale: "document", openLink: () => false };
  function Reader() {
    ctx.panels.useTabTitle?.("A page", React.createElement("span", null, "A"));
    return React.createElement(ctx.conversation.ui.Markdown, document);
  }
  function Workspace() {
    const split: PanelSplit = ctx.panels.ui.useSplit(undefined, "example.plugin:reader", 448, 320);
    const items: PanelWorkspaceItem[] = [{ id: "page", label: "Page", content: React.createElement(Reader), close: () => false }];
    const props: PanelWorkspaceProps = { items, value: "page", select: () => {} };
    return React.createElement("div", { ref: split.ref, style: split.style }, split.handle,
      React.createElement(ctx.panels.ui.Workspace, props));
  }
  void Workspace;
  // @ts-expect-error Channels tab menus are host-owned.
  const tabMenu: PanelWorkspaceProps = { items: [], value: "", select: () => {}, tabMenu: undefined };
  // @ts-expect-error Channels drag plumbing is host-owned.
  const drag: PanelWorkspaceProps = { items: [], value: "", select: () => {}, drag: undefined };
  // @ts-expect-error Conversation identity is host-owned.
  const identity: PanelWorkspaceProps = { items: [], value: "", select: () => {}, identity: undefined };
  // @ts-expect-error Native Close ownership is not a plugin option.
  const main: PanelWorkspaceProps = { items: [], value: "", select: () => {}, main: true };
  // @ts-expect-error Channels selection adoption is host-owned.
  const adoption: PanelWorkspaceProps = { items: [], value: "", select: () => {}, adoptSelection: undefined };
  // @ts-expect-error The injected component has the same narrow contract.
  React.createElement(ctx.panels.ui.Workspace, { items: [], value: "", select: () => {}, main: true });
  // @ts-expect-error Host opening identities are not plugin tab data.
  const instance: PanelWorkspaceItem = { id: "page", label: "Page", content: null, instance: {} };
  void [tabMenu, drag, identity, main, adoption, instance];
  // @ts-expect-error Host link dispatch must synchronously report acceptance.
  const bad: MarkdownProps = { content: "", openLink: async () => true };
  // @ts-expect-error Only supported host heading scales are public.
  const badScale: MarkdownProps = { content: "", scale: "custom" };
  // @ts-expect-error Tab content is required.
  const missing: PanelWorkspaceItem = { id: "page", label: "Page" };
  void [bad, missing];
}
`,
    );
    await writeFile(
      join(dir, "plugin-status-consumer.ts"),
      `
import type { Context } from "@buzz/author";
export function observePlugin(ctx: Context) {
  const owner = ctx.pluginOwner;
  if (!owner) return;
  const id: string = owner.id;
  const revision: string = owner.revision;
  const active: boolean = ctx.pluginStatus.isActive(id, revision);
  const stop: () => void = ctx.pluginStatus.subscribe(() => {
    const current: boolean = ctx.pluginStatus.isActive(id, revision);
    void current;
  });
  stop();
  const settled: boolean | undefined = ctx.pluginStatus.settled?.();
  const withoutReadiness: Context["pluginStatus"] = {
    isActive: () => true,
    subscribe: () => () => {},
  };
  void [active, settled, withoutReadiness];
  // @ts-expect-error A revision is a string, not a generation number.
  ctx.pluginStatus.isActive(id, 1);
  // @ts-expect-error Subscription requires a callback.
  ctx.pluginStatus.subscribe("changed");
  // @ts-expect-error Readiness is optional and must be checked.
  ctx.pluginStatus.settled();
  // @ts-expect-error Installed ownership is readonly.
  owner.revision = "replacement";
}
`,
    );
    await writeFile(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          strict: true,
          skipLibCheck: true,
          noEmit: true,
          types: [],
          paths: {
            "@buzz/author": ["./author package/types/plugins/author.d.ts"],
          },
        },
        files: [
          "consumer.ts",
          "plugin-status-consumer.ts",
          "document-consumer.ts",
        ],
      }),
    );
    // Only generated declarations and the external consumer, never host source.
    run("pnpm", ["exec", "tsc", "-p", join(dir, "tsconfig.json")]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 120_000);
