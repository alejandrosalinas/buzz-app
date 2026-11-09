import "../../../tests/sonner-dom";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AgentTabs } from "../agents/AgentTabs";
import { useAgentSettingsHost } from "../agents/AgentSettingsHost";
import type {
  Agents,
  NewAgent,
  RegisteredAgentType,
} from "../../features/agents/service";
// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { StrictMode, useState } from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Agent, AgentType } from "../../features/agents/service";
import {
  fileStore,
  localStore,
  type AgentStore,
} from "../../features/agents/state";
import type { HostProcessOptions } from "../../features/host/service";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { RelayData } from "../../features/relay/service";
import { ClaudeLogoIcon } from "../../shared/design-system/icons";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { AgentCreateDialog } from "../agents/AgentCreateDialog";
import { manifestProcesses } from "./claude-testing";
import { apply, inject } from "./index";
import { type Config, DEFAULT_CONFIG } from "./runtime";
import { ClaudeSetup } from "./setup";
import { ClaudeDefaults } from "./defaults";

const desktop = vi.hoisted(() => ({ tauri: true }));
/** Native's Claude key store (`claude_key.rs`), which a test sets up. */
const nativeKey = vi.hoisted(() => {
  /** Refuses what is not one `sk-ant-` word, as native does, with its line. */
  const check = async (value: string) => {
    if (!/^sk-ant-[A-Za-z0-9_-]+$/.test(value.trim()))
      throw "That is not an Anthropic API key. Create one at console.anthropic.com and paste it here.";
  };
  return { saved: true, saves: [] as string[], check, save: check };
});
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => desktop.tauri,
  invoke: async (command: string, args?: { value?: string }) => {
    // An IPC round trip, as the host's process steps answer after a turn.
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (command === "claude_api_key_status") return nativeKey.saved;
    if (command === "claude_api_key_set") {
      const value = args?.value ?? "";
      nativeKey.saves.push(value);
      await nativeKey.save(value);
      nativeKey.saved = true;
    }
    return null;
  },
}));
// A build whose auth.tsx signs in interactively, as Block's does: its
// ClaudeAuth has a sign-in step, which here saves the credentials.
const interactive = vi.hoisted(() => ({
  signIn: false,
  /** Exercise setup's real process-step and cancellation path. */
  process: false,
  /** Holds sign-in open until it is called. */
  hold: undefined as Promise<void> | undefined,
}));
vi.mock("./auth", async (actual) => {
  const real = await actual<typeof import("./auth")>();
  class ClaudeAuth extends real.ClaudeAuth {
    override readonly signIn = interactive.signIn
      ? async (step: import("./auth").Step) => {
          if (interactive.process)
            await step("claude", ["auth", "login"], "Sign-in");
          else await interactive.hold;
          nativeKey.saved = true;
        }
      : undefined;
  }
  return { ...real, ClaudeAuth };
});
const dialogMotion = vi.hoisted(() => ({ reduced: false }));
vi.mock("motion/react", async (actual) => ({
  ...(await actual<typeof import("motion/react")>()),
  useReducedMotion: () => dialogMotion.reduced,
}));

beforeEach(() => {
  desktop.tauri = true;
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  // jsdom has no layout observers; the model picker sizes itself with one.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
});
const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  vi.restoreAllMocks();
});

const agent = (config: Config = DEFAULT_CONFIG) =>
  ({
    key: "c".repeat(64),
    pubkey: "c".repeat(64),
    name: "Claude",
    type: "buzz.claude-code/claude-code",
    owner: "a".repeat(64),
    config,
  }) as Agent<Config>;

// jsdom leaves focus on a button that becomes natively disabled, where a
// browser drops it, so the focus tests also check for no `disabled`.

/** The models Claude lists in its answer to `initialize`. */
const CATALOG = [
  {
    value: "default",
    resolvedModel: "claude-opus-5-5",
    displayName: "Default (recommended)",
    description: "Opus 5.5 · Best for everyday, complex tasks",
  },
  {
    value: "opus",
    supportsEffort: true,
    supportedEffortLevels: ["low", "high"],
    resolvedModel: "claude-opus-5-5",
    displayName: "Opus",
    description: "Opus 5.5 · Best for everyday, complex tasks",
  },
  {
    value: "claude-fable-5-1[1m]",
    resolvedModel: "claude-fable-5-1",
    displayName: "Fable",
    description: "Fable 5.1 · Most capable for your hardest tasks",
  },
  {
    value: "sonnet",
    resolvedModel: "claude-sonnet-5-5",
    displayName: "Sonnet",
    description: "Sonnet 5.5 · Efficient for routine tasks",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    value: "haiku",
    resolvedModel: "claude-haiku-4-5",
    displayName: "Haiku",
    description: "Haiku 4.5 · Fastest for quick answers",
    supportsEffort: true,
    supportedEffortLevels: ["low", "high"],
  },
];

/** Applies the plugin to a stand-in context; setup steps run until killed. */
function applied({
  keySaved = true,
  available = true,
  version = "2.1.292",
  latest = version,
  files = {},
  catalog = { listed: true },
  storage,
  channels,
  remote = false,
}: {
  /** Agent storage; this page's localStorage without it. */
  storage?: AgentStore;
  remote?: boolean;
  /** The community's channels; no community connection without them. */
  channels?: readonly ChannelSummary[];
  /** Whether an API key is saved; saving one in a test saves it. */
  keySaved?: boolean;
  available?: boolean;
  version?: string;
  latest?: string;
  files?: Record<string, string>;
  /** Whether Claude lists its models when asked. */
  catalog?: { listed: boolean; ready?: Promise<void>; models?: typeof CATALOG };
} = {}) {
  let type: AgentType<Config> | undefined;
  nativeKey.saved = keySaved;
  nativeKey.saves = [];
  nativeKey.save = nativeKey.check;
  const home = mkdtempSync(join(tmpdir(), "claude-tabs-"));
  homes.push(home);
  for (const [path, content] of Object.entries(files)) {
    const copy = join(home, ".claude/projects", path);
    mkdirSync(dirname(copy), { recursive: true });
    writeFileSync(copy, content);
    // Written an hour ago, so a later listing finds it unchanged.
    const hourAgo = new Date(Date.now() - 3_600_000);
    utimesSync(copy, hourAgo, hourAgo);
  }
  const listed = manifestProcesses(home);
  const spawn = vi.fn(async (id: string, options: HostProcessOptions = {}) => {
    // Claude and its install steps run as steps of claude.sh: its script, $0
    // and step come first.
    const step = id === "claude-sh" ? options.args?.[2] : undefined;
    const name = step === "run" ? "claude" : (step ?? id);
    const args = (options.args ?? []).slice(step ? 3 : 0).join(" ");
    // The manifest's listing and search run for real on a copy of `files`.
    if (name === "list" || name === "starts") return listed(name, options);
    if (name === "workspace" || name === "read") {
      const file = files[args];
      queueMicrotask(() =>
        name === "workspace"
          ? options.onStdout?.("/Users/me/.buzz\n")
          : file === undefined
            ? options.onStderr?.(`base64: ${args}: No such file or directory`)
            : options.onStdout?.(btoa(file)),
      );
      return {
        write: async () => undefined,
        end: async () => undefined,
        kill: async () => undefined,
        exited: new Promise<number>((resolve) =>
          setTimeout(
            () => resolve(name === "read" && file === undefined ? 1 : 0),
            0,
          ),
        ),
      };
    }
    // Buzz's launcher answers 127 when it has no copy.
    const missing = name === "claude" && args === "--version" && !available;
    const streaming = args.includes("--input-format stream-json");
    let kill: () => void = () => undefined;
    const exited = new Promise<number | null>((resolve) => {
      if (name === "install" || streaming || args === "auth login")
        kill = () => resolve(null);
      else setTimeout(() => resolve(missing ? 127 : 0), 0);
    });
    queueMicrotask(() =>
      options.onStdout?.(
        missing
          ? ""
          : name === "install"
            ? "Setting up Claude Code...\n"
            : name === "platform"
              ? "Darwin arm64\n"
              : args === "--version"
                ? `${version} (Claude Code)\n`
                : "",
      ),
    );
    return {
      write: async (text: string) => {
        if (!streaming) return;
        const message = JSON.parse(text) as {
          request_id?: string;
          request?: { subtype?: string };
        };
        if (message.request?.subtype !== "initialize") return;
        await catalog.ready;
        queueMicrotask(() =>
          options.onStdout?.(
            `${JSON.stringify({
              type: "control_response",
              response: {
                subtype: "success",
                request_id: message.request_id,
                response: {
                  models: catalog.listed ? (catalog.models ?? CATALOG) : [],
                },
              },
            })}\n`,
          ),
        );
      },
      end: async () => undefined,
      kill: async () => kill(),
      exited,
    };
  });
  const ctx = {
    pluginOwner: { id: "buzz.claude-code", revision: "r1" },
    navigation: { open: vi.fn(async () => ({ status: "opened" })) },
    agentProtection: { registerModels: vi.fn() },
    host: {
      spawn,
      // Offer the installed release unless the test requests an update.
      request: vi.fn(async ({ url }: { url: string }) => ({
        status: 200,
        headers: {},
        body: url.endsWith("/latest")
          ? latest
          : JSON.stringify({
              platforms: { "darwin-arm64": { checksum: "a".repeat(64) } },
            }),
      })),
    },
    agents: {
      storage,
      executionBinding: () => (remote ? { provider: "nexus/blox" } : undefined),
      inspectExecution: vi.fn(async () =>
        remote ? { provider: "nexus/blox" } : undefined,
      ),
      execution: vi.fn(async () => {
        throw new Error("Settings must not open a target");
      }),
      register: (registered: AgentType<Config>) => {
        type = registered;
      },
      snapshot: () => ({ status: "ready", agents: [], running: [] }),
      relay: () =>
        channels &&
        ({
          snapshot: () => ({
            status: "ready",
            session: { channels: { list: () => ({ channels }) } },
          }),
        } as unknown as RelayData),
      subscribe: () => () => undefined,
    },
    effect: vi.fn(),
  };
  apply(ctx as never);
  return {
    type,
    spawn,
    home,
    execution: ctx.agents.execution,
    navigation: ctx.navigation,
    setRemote: (value: boolean) => {
      remote = value;
    },
  };
}
function installed(options?: Parameters<typeof applied>[0]) {
  const result = applied(options);
  if (!result.type) throw new Error("no type registered");
  return { ...result, type: result.type };
}
function tab(type: AgentType<Config>, index: number) {
  const component = type.tabs?.[index]?.component;
  if (!component) throw new Error("no tab");
  return component;
}
function providerSetup(type: AgentType<Config>) {
  if (!type.provider) throw new Error("no provider contribution");
  return type.provider.DialogBody;
}
async function choose(label: string, option: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: label }));
  await user.click(await screen.findByRole("option", { name: option }));
}

it("shows each saved conversation's channel with the sidebar's icon", () => {
  localStorage.setItem(
    "buzz.claude-code.sessions.v1",
    JSON.stringify({
      [agent().key]: {
        public: { id: "s1", seen: 0, at: 4 },
        private: { id: "s2", seen: 0, at: 3 },
        dm: { id: "s3", seen: 0, at: 2 },
        solo: { id: "s4", seen: 0, at: 1 },
      },
    }),
  );
  const Activity = tab(
    installed({
      channels: [
        { id: "public", name: "general", channelType: "stream" },
        { id: "private", name: "plans", channelType: "stream", private: true },
        { id: "dm", name: "Pinky", channelType: "dm", hidden: true },
        { id: "solo", name: "Notes", channelType: "solo", private: true },
      ],
    }).type,
    1,
  );
  render(<Activity agent={agent()} save={vi.fn()} />);
  const shown = (row: HTMLElement) => {
    const name = within(row).getByTitle(/ · channel$/);
    const icon = name.querySelector("svg")?.getAttribute("class");
    return `${icon?.match(/tabler-icon-[\w-]+/)?.[0]} ${name.textContent}`;
  };
  expect(
    screen.getAllByRole("listitem").map((row) => shown(row as HTMLElement)),
  ).toEqual([
    "tabler-icon-hash general",
    "tabler-icon-lock plans",
    "tabler-icon-message-circle Pinky",
    "tabler-icon-message-circle Notes",
  ]);
  expect(
    screen.getByRole("button", { name: "View transcript: plans · channel" }),
  ).toBeVisible();
});

it("lists saved conversations and shows one's transcript, or that it is gone", async () => {
  const thread = `channel/${"e".repeat(64)}`;
  localStorage.setItem(
    "buzz.claude-code.sessions.v1",
    JSON.stringify({
      [agent().key]: {
        channel: { id: "deleted", seen: 0, at: 1 },
        [thread]: { id: "kept", seen: 0, at: 2 },
      },
    }),
  );
  const transcript = [
    JSON.stringify({
      type: "user",
      uuid: "u1",
      timestamp: "2026-10-09T10:00:00Z",
      message: {
        content:
          "<buzz-event>\nEvent ID: e\nContent: what changed?\nTags: []\n</buzz-event>",
      },
    }),
    JSON.stringify({
      type: "assistant",
      uuid: "u2",
      timestamp: "2026-10-09T10:00:05Z",
      message: { content: [{ type: "text", text: "Two files." }] },
    }),
  ].join("\n");
  const Activity = tab(
    installed({ files: { "./-Users-me--buzz/kept.jsonl": transcript } }).type,
    1,
  );
  const save = vi.fn();
  render(<Activity agent={agent()} save={save} />);
  const user = userEvent.setup();
  const rows = screen.getAllByRole("listitem");
  expect(
    within(rows[0] as HTMLElement).getByRole("button", {
      name: "View transcript: channel · thread eeeeeeee",
    }),
  ).toBeVisible();
  expect(
    within(rows[1] as HTMLElement).getByRole("button", {
      name: "View transcript: channel · channel",
    }),
  ).toBeVisible();
  const viewButton = (index: number) =>
    screen.getAllByRole("button", { name: /^View transcript/ })[
      index
    ] as HTMLElement;
  await user.click(viewButton(0));
  expect(
    await screen.findByText("what changed?", { selector: "summary span" }),
  ).toBeVisible();
  expect(
    screen.getByText("Two files.", { selector: "summary span" }),
  ).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Refresh transcript" }));
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Refresh transcript" }),
    ).not.toHaveAttribute("data-loading"),
  );
  expect(
    screen.getByText("Two files.", { selector: "summary span" }),
  ).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Back to profile" }));
  await user.click(viewButton(1));
  expect(
    await screen.findByText(/no transcript for this conversation/),
  ).toBeVisible();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(save).not.toHaveBeenCalled();
});

it("reads an open transcript again in place when its conversation's session changes", async () => {
  const thread = `channel/${"e".repeat(64)}`;
  const saved = (id: string) =>
    localStorage.setItem(
      "buzz.claude-code.sessions.v1",
      JSON.stringify({ [agent().key]: { [thread]: { id, seen: 0, at: 1 } } }),
    );
  const session = (uuid: string, text: string) =>
    [
      JSON.stringify({
        type: "user",
        uuid,
        timestamp: "2026-10-09T10:00:00Z",
        message: {
          content: `<buzz-event>\nEvent ID: e\nContent: ${text}\nTags: []\n</buzz-event>`,
        },
      }),
    ].join("\n");
  saved("first");
  const Activity = tab(
    installed({
      files: {
        "./-Users-me--buzz/first.jsonl": session("u1", "older ask"),
        "./-Users-me--buzz/second.jsonl": session("u2", "newer ask"),
      },
    }).type,
    1,
  );
  const view = render(<Activity agent={agent()} save={vi.fn()} />);
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: /^View transcript/ }));
  const older = await screen.findByText("older ask", {
    selector: "summary span",
  });
  saved("second");
  view.rerender(<Activity agent={agent()} save={vi.fn()} />);
  // The view isn't cleared while the new session reads.
  expect(screen.queryByText("Reading the Claude session…")).toBeNull();
  expect(older).toBeInTheDocument();
  expect(
    await screen.findByText("newer ask", { selector: "summary span" }),
  ).toBeVisible();
});

it("opens the conversation's transcript when opened from its activity, once", async () => {
  const root = "e".repeat(64);
  localStorage.setItem(
    "buzz.claude-code.sessions.v1",
    JSON.stringify({
      [agent().key]: { [`channel/${root}`]: { id: "kept", seen: 0, at: 2 } },
    }),
  );
  const transcript = JSON.stringify({
    type: "assistant",
    uuid: "u1",
    timestamp: "2026-10-09T10:00:05Z",
    message: { content: [{ type: "text", text: "Two files." }] },
  });
  const Activity = tab(
    installed({ files: { "./-Users-me--buzz/kept.jsonl": transcript } }).type,
    1,
  );
  const conversation = { channelId: "channel", rootId: root };
  const { unmount } = render(
    <Activity
      agent={agent()}
      save={vi.fn()}
      conversation={conversation}
      initialTranscript={{ opening: 1, done: () => undefined }}
    />,
  );
  const user = userEvent.setup();
  expect(
    await screen.findByText("Two files.", { selector: "summary span" }),
  ).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Back to profile" }));
  expect(
    screen.getByRole("button", {
      name: "View transcript: channel",
    }),
  ).toBeVisible();
  expect(
    screen.queryByText("Two files.", { selector: "summary span" }),
  ).toBeNull();
  unmount();
  // Opened from the profile itself, it lists conversations instead.
  render(
    <Activity agent={agent()} save={vi.fn()} conversation={conversation} />,
  );
  expect(
    screen.getByRole("button", {
      name: "View transcript: channel",
    }),
  ).toBeVisible();
  expect(
    screen.queryByText("Two files.", { selector: "summary span" }),
  ).toBeNull();
});

it("opens a channel's session transcript when opened from one of its threads' activity", async () => {
  // A Solo chat, DM or channel-scoped agent keeps one session per channel, so
  // the thread's own lookup finds it only after the profile is shown.
  localStorage.setItem(
    "buzz.claude-code.sessions.v1",
    JSON.stringify({
      [agent().key]: { channel: { id: "kept", seen: 0, at: 2 } },
    }),
  );
  const transcript = JSON.stringify({
    type: "assistant",
    uuid: "u1",
    timestamp: "2026-10-09T10:00:05Z",
    message: { content: [{ type: "text", text: "Two files." }] },
  });
  const Activity = tab(
    installed({ files: { "./-Users-me--buzz/kept.jsonl": transcript } }).type,
    1,
  );
  const done = vi.fn();
  render(
    <Activity
      agent={agent()}
      save={vi.fn()}
      conversation={{ channelId: "channel", rootId: "e".repeat(64) }}
      initialTranscript={{ opening: 1, done }}
    />,
  );
  expect(
    await screen.findByText("Two files.", { selector: "summary span" }),
  ).toBeVisible();
  expect(done).toHaveBeenCalledTimes(1);
});

it("shows the transcript and that sessions may be missing when some history cannot be read", async () => {
  localStorage.setItem(
    "buzz.claude-code.sessions.v1",
    JSON.stringify({
      [agent().key]: {
        [`channel/${"e".repeat(64)}`]: { id: "kept", seen: 0, at: 2 },
      },
    }),
  );
  const transcript = [
    JSON.stringify({
      type: "user",
      uuid: "u1",
      timestamp: "2026-10-09T10:00:00Z",
      message: {
        content:
          "<buzz-event>\nEvent ID: e\nContent: what changed?\nTags: []\n</buzz-event>",
      },
    }),
  ].join("\n");
  const { type, home } = installed({
    files: {
      "./-Users-me--buzz/kept.jsonl": transcript,
      "./-Users-me--buzz/unreadable.jsonl": transcript,
    },
  });
  chmodSync(join(home, ".claude/projects/-Users-me--buzz/unreadable.jsonl"), 0);
  const Activity = tab(type, 1);
  render(<Activity agent={agent()} save={vi.fn()} />);
  const user = userEvent.setup();
  await user.click(
    screen.getAllByRole("button", {
      name: /^View transcript/,
    })[0] as HTMLElement,
  );
  expect(
    await screen.findByText("what changed?", { selector: "summary span" }),
  ).toBeVisible();
  expect(
    screen.getByText(/sessions may be missing\. Refresh to try again\./),
  ).toHaveTextContent(/unreadable\.jsonl/);
  expect(screen.queryByRole("alert")).toBeNull();
});

it("sets the conversation the profile was opened from apart from recent conversations", () => {
  const root = "e".repeat(64);
  localStorage.setItem(
    "buzz.claude-code.sessions.v1",
    JSON.stringify({
      [agent().key]: {
        channel: { id: "channel-session", seen: 0, at: 1 },
        [`channel/${root}`]: { id: "thread-session", seen: 0, at: 2 },
      },
    }),
  );
  const Activity = tab(installed().type, 1);
  render(
    <Activity
      agent={agent()}
      save={vi.fn()}
      conversation={{ channelId: "channel", rootId: root }}
    />,
  );
  const opened = screen.getByRole("region", { name: "This thread" });
  expect(
    within(opened).getByRole("button", { name: /^View transcript/ }),
  ).toBeVisible();
  expect(screen.getAllByRole("listitem")).toHaveLength(1);
  expect(
    screen.getByRole("button", { name: "View transcript: channel · channel" }),
  ).toBeVisible();
  // Unlisted by the community, their kind is unknown: no icon claims one.
  expect(within(opened).getByTitle("channel").querySelector("svg")).toBeNull();
  expect(
    screen.getByTitle("channel · channel").querySelector("svg"),
  ).toBeNull();
});

it("lists the opened conversation's channel above newer conversations", () => {
  const [one, two] = ["e".repeat(64), "f".repeat(64)];
  localStorage.setItem(
    "buzz.claude-code.sessions.v1",
    JSON.stringify({
      [agent().key]: {
        newest: { id: "newest-session", seen: 0, at: 3 },
        [`here/${one}`]: { id: "here-session", seen: 0, at: 1 },
        older: { id: "older-session", seen: 0, at: 2 },
      },
    }),
  );
  const Activity = tab(installed().type, 1);
  render(
    <Activity
      agent={agent()}
      save={vi.fn()}
      conversation={{ channelId: "here", rootId: two }}
    />,
  );
  expect(
    screen
      .getAllByRole("listitem")
      .map((item) => within(item).getByTitle(/ · /).getAttribute("title")),
  ).toEqual(["here · thread eeeeeeee", "newest · channel", "older · channel"]);
});

it("finds the thread's Claude session another build started", async () => {
  const root = "f".repeat(64);
  const started = JSON.stringify({
    type: "user",
    uuid: "u1",
    timestamp: "2026-10-09T10:00:00Z",
    message: {
      content: `<context>\nScope: thread\nSession scope: thread\nChannel: dev (#channel)\nThread root: ${root}\nAgent: ${agent().key}\n</context>\n\n<buzz-event>\nEvent ID: e\nContent: what changed?\nTags: []\n</buzz-event>`,
    },
  });
  const { type, spawn } = installed({
    files: { "./-Users-me--buzz/elsewhere.jsonl": started },
  });
  const Activity = tab(type, 1);
  const open = async () => {
    const view = render(
      <Activity
        agent={agent()}
        save={vi.fn()}
        conversation={{ channelId: "channel", rootId: root }}
      />,
    );
    const opened = screen.getByRole("region", { name: "This thread" });
    fireEvent.click(
      await within(opened).findByRole("button", { name: /^View transcript/ }),
    );
    expect(
      await screen.findByText("what changed?", { selector: "summary span" }),
    ).toBeVisible();
    view.unmount();
  };
  const searches = () =>
    spawn.mock.calls.filter(([id]) => id === "starts").length;
  await open();
  const searched = searches();
  // Opened again, it searches no file it already searched.
  await open();
  expect(searched).toBeGreaterThan(0);
  expect(searches()).toBe(searched);
});

it("shows the channel's current kind for a session another build started", async () => {
  const root = "f".repeat(64);
  const started = JSON.stringify({
    type: "user",
    uuid: "u1",
    timestamp: "2026-10-09T10:00:00Z",
    message: {
      content: `<context>\nScope: thread\nSession scope: thread\nChannel: dev (#channel)\nThread root: ${root}\nAgent: ${agent().key}\n</context>\n\n<buzz-event>\nEvent ID: e\nContent: what changed?\nTags: []\n</buzz-event>`,
    },
  });
  const channels: ChannelSummary[] = [
    { id: "channel", name: "dev", channelType: "stream" },
  ];
  const { type, spawn } = installed({
    files: { "./-Users-me--buzz/elsewhere.jsonl": started },
    channels,
  });
  const Activity = tab(type, 1);
  // A new element each time, so that rerendering renders the tab again.
  const shown = () => (
    <Activity
      agent={agent()}
      save={vi.fn()}
      conversation={{ channelId: "channel", rootId: root }}
    />
  );
  const view = render(shown());
  const here = screen.getByRole("region", { name: "This thread" });
  await within(here).findByRole("button", { name: /^View transcript/ });
  expect(within(here).getByTitle("dev").querySelector("svg")).toHaveClass(
    "tabler-icon-hash",
  );
  const searched = spawn.mock.calls.filter(([id]) => id === "starts").length;

  channels[0] = {
    id: "channel",
    name: "plans",
    channelType: "stream",
    private: true,
  };
  view.rerender(shown());
  expect(within(here).getByTitle("plans").querySelector("svg")).toHaveClass(
    "tabler-icon-lock",
  );
  expect(spawn.mock.calls.filter(([id]) => id === "starts").length).toBe(
    searched,
  );
});

it("is an agent type on the desktop app", () => {
  expect(inject).toEqual(["agents", "host", "agentProtection", "navigation"]);
  const { type } = installed();
  expect(type).toMatchObject({
    id: "claude-code",
    title: "Claude",
    icon: ClaudeLogoIcon,
  });
  expect(type.defaults()).toEqual({ config: DEFAULT_CONFIG });
  expect(
    type.adopt?.(
      { instructions: "Triage.", workspace: "~/code" },
      DEFAULT_CONFIG,
    ),
  ).toEqual({
    ...DEFAULT_CONFIG,
    instructions: "Triage.",
    workspace: "~/code",
  });
  expect(type.adopt?.({}, DEFAULT_CONFIG)).toEqual(DEFAULT_CONFIG);
  expect(type.carry?.(DEFAULT_CONFIG)).toEqual({});
  expect(
    type.carry?.({
      model: "opus",
      effort: "high",
      instructions: "Triage.",
      workspace: "~/code",
      scope: "channel",
    }),
  ).toEqual({ instructions: "Triage.", workspace: "~/code" });
  expect(type.describeMigration?.(DEFAULT_CONFIG)).toEqual([
    { id: "model", label: "Model", isOverride: false },
    { id: "thinking", label: "Thinking", isOverride: false },
    {
      id: "sessions",
      label: "Sessions",
      isOverride: false,
      unchangedKey: "thread",
    },
  ]);
  expect(
    type.describeMigration?.({
      ...DEFAULT_CONFIG,
      model: "opus",
      effort: "high",
      scope: "channel",
    }),
  ).toEqual([
    { id: "model", label: "Model", isOverride: true },
    { id: "thinking", label: "Thinking", isOverride: true },
    {
      id: "sessions",
      label: "Sessions",
      isOverride: true,
      unchangedKey: "channel",
    },
  ]);
  expect(type.summary?.(agent({ ...DEFAULT_CONFIG, model: "opus" }))).toBe(
    "opus",
  );
  expect(type.provider).toBeDefined();
  expect(type.tabs?.map(({ title, role }) => [title, role])).toEqual([
    ["Settings", "settings"],
    ["Activity", "activity"],
  ]);
});

it("registers only where setup's bash and base64 exist", () => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
  expect(applied().type).toBeDefined();
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
  expect(applied().type).toBeUndefined();
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  desktop.tauri = false;
  expect(applied().type).toBeUndefined();
});

it("keeps provider readiness quiet and agent sessions out of Settings", async () => {
  const installedType = installed().type;
  const Setup = providerSetup(installedType);
  render(<Setup onClose={vi.fn()} />);
  expect(
    await screen.findByText("Claude runs with your Anthropic API key."),
  ).toBeVisible();
  expect(screen.queryByLabelText("Default model")).not.toBeInTheDocument();
  expect(screen.queryByText("Connection")).not.toBeInTheDocument();
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  cleanup();
  const Settings = tab(installedType, 0);
  render(<Settings agent={agent()} save={vi.fn()} />);
  expect(screen.getByLabelText("Workspace")).toBeInTheDocument();
  expect(screen.queryByText("Recent conversations")).not.toBeInTheDocument();
  cleanup();
  const Activity = tab(installedType, 1);
  render(<Activity agent={agent()} save={vi.fn()} />);
  expect(
    screen.getByText("No other conversations saved in this app yet."),
  ).toBeInTheDocument();
});

it("edits the model through the Settings dropdown and preserves agent inheritance", async () => {
  const installedType = installed().type;
  const Control = installedType.provider?.DefaultControl;
  if (!Control) throw new Error("Missing default control");
  render(<Control onConfigure={vi.fn()} />);
  const user = userEvent.setup();
  const control = await screen.findByRole("button", {
    name: /^Claude default model:/,
  });
  await waitFor(() => expect(control).toHaveTextContent("Opus 5.5"));
  await user.click(control);
  fireEvent.click(await screen.findByRole("menuitem", { name: "Claude" }));
  fireEvent.click(
    await screen.findByRole("menuitemradio", { name: "Fable 5.1" }),
  );
  cleanup();
  const Settings = tab(installedType, 0);
  const save = vi.fn(async () => undefined);
  render(<Settings agent={agent()} save={save} />);
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "Model" })).toHaveTextContent(
      "Fable 5.1",
    ),
  );
  expect(save).not.toHaveBeenCalled();
});

it("keeps the saved default and shows the error while a default could not be saved", async () => {
  let failing = true;
  const storage = fileStore(new Map(), async () => {
    if (failing) throw new Error("disk full");
  });
  const Control = installed({ storage }).type.provider?.DefaultControl;
  if (!Control) throw new Error("Missing default control");
  render(<Control onConfigure={vi.fn()} />);
  const control = await screen.findByRole("button", {
    name: /^Claude default model:/,
  });
  await waitFor(() => expect(control).toHaveTextContent("Opus 5.5"));
  const pick = async () => {
    fireEvent.click(control);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Claude" }));
    fireEvent.click(
      await screen.findByRole("menuitemradio", { name: "Fable 5.1" }),
    );
  };
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  await pick();
  expect(await screen.findByRole("alert")).toHaveTextContent("disk full");
  error.mockRestore();
  expect(control).toHaveTextContent("Opus 5.5");
  expect(storage.get("buzz.claude-code.provider-defaults.v1")).toBeNull();
  // The same choice can be saved again.
  failing = false;
  await pick();
  await waitFor(() =>
    expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
  );
  expect(control).toHaveTextContent("Fable 5.1");
  expect(storage.get("buzz.claude-code.provider-defaults.v1")).toContain(
    "fable",
  );
});

it("preserves native behavior for invalid defaults and keeps explicit agent models", async () => {
  localStorage.setItem("buzz.claude-code.provider-defaults.v1", "not json");
  const defaults = new ClaudeDefaults(localStore());
  expect(defaults.resolve(DEFAULT_CONFIG)).toEqual(DEFAULT_CONFIG);
  await defaults.save({ model: "sonnet" });
  const inherited = { ...DEFAULT_CONFIG };
  expect(defaults.resolve(inherited).model).toBe("sonnet");
  expect(inherited).toEqual(DEFAULT_CONFIG);
  expect(defaults.resolve({ ...DEFAULT_CONFIG, model: "opus" }).model).toBe(
    "opus",
  );
});

it("asks for an API key and is ready once one is saved", async () => {
  const { type, spawn } = installed({ keySaved: false });
  const Setup = providerSetup(type);
  const onClose = vi.fn();
  render(<Setup onClose={onClose} />);
  const user = userEvent.setup();
  // The key's form takes the dialog over, saying once is enough.
  expect(
    await screen.findByText(
      "Claude requires an API key to connect to your account. Create one at console.anthropic.com and paste it below. You only have to set this up once, and Buzz keeps it securely on this computer.",
    ),
  ).toBeVisible();
  expect(
    screen.queryByText("Claude 2.1.292 needs an Anthropic API key."),
  ).toBeNull();
  expect(type.provider?.snapshot()).toMatchObject({
    readiness: "attention",
    attentionLabel: "Add Claude API key",
  });
  // The key goes in the dialog, not through a footer action.
  expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
  const field = screen.getByLabelText("Anthropic API key");
  expect(field).toHaveAttribute("type", "password");
  await user.type(field, "sk-ant-api03-pasted");
  await user.click(screen.getByRole("button", { name: "Save key" }));
  expect(
    await screen.findByText("Claude runs with your Anthropic API key."),
  ).toBeVisible();
  expect(type.provider?.snapshot()).toEqual({ readiness: "ready" });
  // Native keeps the key; no process is given it to save.
  expect(nativeKey.saves).toEqual(["sk-ant-api03-pasted"]);
  expect(JSON.stringify(spawn.mock.calls)).not.toContain("sk-ant-api03-pasted");
  // The key is all the dialog edits, so saving it closes the dialog.
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("closes the configuration once a replacement key is saved", async () => {
  const { type } = installed();
  const Setup = providerSetup(type);
  const onClose = vi.fn();
  render(<Setup onClose={onClose} />);
  const user = userEvent.setup();
  await user.type(
    await screen.findByLabelText("Replace API key"),
    "sk-ant-api03-other{Enter}",
  );
  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
});

it("saves the key with Enter without submitting the form it sits in", async () => {
  const { type } = installed({ keySaved: false });
  const Setup = providerSetup(type);
  const outer = vi.fn((event: { preventDefault(): void }) =>
    event.preventDefault(),
  );
  // As agent creation and Settings hold it.
  render(
    <form onSubmit={outer}>
      <Setup onClose={vi.fn()} />
    </form>,
  );
  const user = userEvent.setup();
  await user.type(
    await screen.findByLabelText("Anthropic API key"),
    "sk-ant-api03-pasted{Enter}",
  );
  expect(
    await screen.findByText("Claude runs with your Anthropic API key."),
  ).toBeVisible();
  expect(nativeKey.saves).toEqual(["sk-ant-api03-pasted"]);
  expect(outer).not.toHaveBeenCalled();
});

it("replaces generic installation copy with the latest installer state", async () => {
  const installedType = installed({ available: false }).type;
  const Setup = providerSetup(installedType);
  render(<Setup onClose={vi.fn()} />);
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent(
      "Claude is not installed.",
    ),
  );
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Install Claude" }));
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent(
      "Setting up Claude Code...",
    ),
  );
  expect(screen.queryByText("Installing Claude Code…")).toBeNull();
  expect(screen.queryByLabelText("Setup output")).toBeNull();
});

it("opens its dialog for a missing key rather than running a step", async () => {
  const { type } = installed({ keySaved: false });
  await waitFor(() =>
    expect(type.provider?.snapshot()).toMatchObject({
      readiness: "attention",
      attentionLabel: "Add Claude API key",
    }),
  );
  expect(type.provider?.attentionAction).toBeUndefined();
});

it("saves settings as one config", async () => {
  const Settings = tab(installed().type, 0);
  const save = vi.fn(async () => undefined);
  render(<Settings agent={agent()} save={save} />);
  const user = userEvent.setup();
  expect(
    screen.queryByRole("button", { name: "Save" }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("combobox", { name: "Model" }));
  const sonnet = await screen.findByRole("option", { name: "Sonnet 5.5" });
  expect(sonnet).toHaveAccessibleDescription("Efficient for routine tasks");
  await user.click(sonnet);
  expect(screen.getByLabelText("Workspace")).toHaveAccessibleDescription(
    "The folder Claude works in. Use ~/ for your home folder.",
  );
  await user.clear(screen.getByLabelText("Workspace"));
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(save).toHaveBeenCalledWith(
    { ...DEFAULT_CONFIG, model: "sonnet", workspace: "~/.buzz" },
    { base: {} },
  );
});

it("offers the model's thinking levels, dropping one the next model lacks", async () => {
  const Settings = tab(installed().type, 0);
  const save = vi.fn(async () => undefined);
  render(<Settings agent={agent()} save={save} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: "Model" }));
  await user.click(await screen.findByRole("option", { name: "Sonnet 5.5" }));
  await user.click(screen.getByRole("combobox", { name: "Thinking" }));
  expect(
    (await screen.findAllByRole("option")).map((option) => option.textContent),
  ).toEqual(["Automatic · Default", "Low", "Medium", "High", "Extra high"]);
  await user.click(screen.getByRole("option", { name: "Extra high" }));
  await user.click(screen.getByRole("combobox", { name: "Model" }));
  await user.click(await screen.findByRole("option", { name: "Haiku 4.5" }));
  const thinking = screen.getByRole("combobox", { name: "Thinking" });
  expect(thinking).toHaveTextContent("Automatic · Default");
  await user.click(thinking);
  await user.click(await screen.findByRole("option", { name: "High" }));
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(save).toHaveBeenCalledWith(
    { ...DEFAULT_CONFIG, model: "haiku", effort: "high" },
    { base: {} },
  );
});

it("keeps a saved thinking level changeable without Claude's model list", async () => {
  const Settings = tab(installed({ catalog: { listed: false } }).type, 0);
  const save = vi.fn(async () => undefined);
  render(
    <Settings
      agent={agent({ ...DEFAULT_CONFIG, effort: "high" })}
      save={save}
    />,
  );
  const user = userEvent.setup();
  const thinking = screen.getByRole("combobox", { name: "Thinking" });
  expect(thinking).toHaveTextContent("High");
  expect(thinking).not.toHaveTextContent("unavailable");
  await user.click(thinking);
  await user.click(
    await screen.findByRole("option", { name: "Automatic · Default" }),
  );
  expect(thinking).toHaveTextContent("Automatic · Default");
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(save).toHaveBeenCalledWith(DEFAULT_CONFIG, { base: {} });
});

it("disables create-time Thinking when Claude model discovery fails", async () => {
  const { type, spawn } = installed();
  const Model = type.CreateModel;
  const Thinking = type.CreateThinking;
  if (!Model || !Thinking) throw new Error("Missing create controls");
  const original = spawn.getMockImplementation();
  if (!original) throw new Error("Missing process fixture");
  spawn.mockImplementation(async (id, options = {}) => {
    if (options.args?.includes("--input-format"))
      throw new Error("model catalog unavailable");
    return original(id, options);
  });
  const config = { ...DEFAULT_CONFIG, model: "sonnet", effort: "high" };
  const onChange = vi.fn();
  render(
    <>
      <Model config={config} onChange={onChange} disabled={false} />
      <Thinking config={config} onChange={onChange} disabled={false} />
    </>,
  );
  const thinking = await screen.findByRole("combobox", { name: "Thinking" });
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "model catalog unavailable",
  );
  expect(thinking).toBeDisabled();
  expect(thinking).toHaveTextContent("High");
  expect(thinking).not.toHaveTextContent("High (unavailable)");
  expect(onChange).not.toHaveBeenCalled();
});

it("keeps Save focused while saving, and lets a failed save be retried", async () => {
  const Settings = tab(installed().type, 0);
  let fail: (error: Error) => void = () => undefined;
  const save = vi
    .fn<(config: Config) => Promise<void>>()
    .mockImplementationOnce(
      () => new Promise((_resolve, reject) => (fail = reject)),
    )
    .mockResolvedValueOnce(undefined);
  render(<Settings agent={agent()} save={save} />);
  const user = userEvent.setup();
  await choose("Model", "Haiku 4.5");
  const saveButton = screen.getByRole("button", { name: "Save" });
  await user.click(saveButton);
  expect(saveButton).toHaveAttribute("aria-busy", "true");
  expect(saveButton).toHaveFocus();
  expect(saveButton).not.toHaveAttribute("disabled");
  fail(new Error("Relay rejected the change"));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Relay rejected the change",
  );
  expect(screen.getByRole("alert")).toHaveFocus();
  await user.click(saveButton);
  expect(save).toHaveBeenCalledTimes(2);
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
});

it("starts a new agent with finite model choices and preserves its other settings", async () => {
  const { type } = installed();
  const Create = type.Create;
  const Model = type.CreateModel;
  if (!Create || !Model) throw new Error("Missing creation controls");
  const config = {
    ...DEFAULT_CONFIG,
    workspace: "~/code",
    scope: "channel" as const,
    instructions: "Triage.",
  };
  const onChange = vi.fn();
  render(
    <>
      <Create config={config} onChange={onChange} disabled={false} />
      <Model config={config} onChange={onChange} disabled={false} />
    </>,
  );
  const picker = await screen.findByRole("combobox", { name: "Model" });
  await waitFor(() => expect(picker).toBeEnabled());
  const user = userEvent.setup();
  await user.click(picker);
  expect(
    screen.queryByRole("option", { name: "Custom model" }),
  ).not.toBeInTheDocument();
  await user.click(
    await screen.findByRole("option", {
      name: "Opus 5.5 · Default",
      description: "Best for everyday, complex tasks",
    }),
  );
  expect(onChange).toHaveBeenLastCalledWith({ ...config, model: "" });
  expect(screen.getByLabelText("Instructions Optional")).toHaveValue("Triage.");
  fireEvent.change(screen.getByLabelText("Instructions Optional"), {
    target: { value: "Plan." },
  });
  expect(onChange).toHaveBeenLastCalledWith({
    ...config,
    instructions: "Plan.",
  });
});

it("uses Claude's effort catalog at creation and reopens the saved choice", async () => {
  let releaseCatalog!: () => void;
  const catalogReady = new Promise<void>((resolve) => {
    releaseCatalog = resolve;
  });
  const loads = vi.spyOn(ClaudeSetup.prototype, "loadModels");
  const { type } = installed({
    catalog: { listed: true, ready: catalogReady },
  });
  const Thinking = type.CreateThinking;
  const Model = type.CreateModel;
  const Settings = tab(type, 0);
  if (!Thinking || !Model) throw new Error("Missing create controls");
  const config = { ...DEFAULT_CONFIG, model: "sonnet" };
  const onChange = vi.fn();
  const view = render(
    <>
      <Model config={config} onChange={onChange} disabled={false} />
      <Thinking config={config} onChange={onChange} disabled={false} />
    </>,
  );
  const control = await screen.findByRole("combobox", { name: "Thinking" });
  try {
    await waitFor(() => expect(loads).toHaveBeenCalled());
    const model = await screen.findByRole("combobox", { name: "Model" });
    await waitFor(() => expect(model).toBeDisabled());
    expect(control).toBeDisabled();
  } finally {
    releaseCatalog();
  }
  await waitFor(() => expect(control).toBeEnabled());
  expect(control).toHaveTextContent("Automatic · Default");

  const user = userEvent.setup();
  await user.click(control);
  expect(
    (await screen.findAllByRole("option")).map((option) => option.textContent),
  ).toEqual(["Automatic · Default", "Low", "Medium", "High", "Extra high"]);
  await user.click(screen.getByRole("option", { name: "Extra high" }));
  expect(onChange).toHaveBeenLastCalledWith({ ...config, effort: "xhigh" });
  view.unmount();

  render(
    <Settings
      agent={agent({ ...config, effort: "xhigh" })}
      save={vi.fn(async () => undefined)}
    />,
  );
  expect(screen.getByRole("combobox", { name: "Thinking" })).toHaveTextContent(
    "Extra high",
  );
});

it.each(["unrelated", "thinking", "model"])(
  "preserves saved Claude Thinking through an update unless explicitly edited (%s)",
  async (edit) => {
    const { type } = installed({
      catalog: {
        listed: true,
        models: CATALOG.map((model) => ({
          ...model,
          supportsEffort: true,
          supportedEffortLevels: ["low"],
        })),
      },
    });
    const existing = agent({
      ...DEFAULT_CONFIG,
      model: "sonnet",
      effort: "high",
    });
    const onSave = vi.fn(async (_input: NewAgent) => undefined);
    render(
      <AgentCreateDialog
        agents={{} as Agents}
        types={[{ ...type, key: existing.type } as RegisteredAgentType]}
        onCreated={vi.fn()}
        onClose={vi.fn()}
        update={{
          agent: existing,
          onSave,
          request: {
            id: "update",
            requester: "requester",
            requesterName: "Parent",
            owner: existing.owner,
            community: "here",
            agent: existing.pubkey,
            agentName: existing.name,
            agentType: existing.type,
            name: "Renamed",
            instructions: "Review PRs.",
          },
        }}
      />,
    );
    const user = userEvent.setup();
    const thinking = await screen.findByRole("combobox", { name: "Thinking" });
    await waitFor(() => expect(thinking).toBeEnabled());
    if (edit === "thinking") {
      await user.click(thinking);
      await user.click(await screen.findByRole("option", { name: "Low" }));
    } else if (edit === "model") {
      await user.click(screen.getByRole("combobox", { name: "Model" }));
      await user.click(
        await screen.findByRole("option", { name: "Haiku 4.5" }),
      );
    }
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Renamed",
          config: {
            ...existing.config,
            instructions: "Review PRs.",
            model: edit === "model" ? "haiku" : "sonnet",
            effort:
              edit === "thinking" ? "low" : edit === "model" ? "" : "high",
          },
        }),
      ),
    );
  },
);

it("passes the real Claude Thinking choice through Create agent", async () => {
  const { type } = installed();
  if (!type) throw new Error("no type registered");
  const registeredType = {
    ...type,
    key: "buzz.claude-code/claude-code",
    pluginId: "buzz.claude-code",
    revision: "r1",
  } as unknown as RegisteredAgentType;
  let saved: Agent<Config> | undefined;
  const create = vi.fn(async (input: NewAgent) => {
    saved = {
      ...agent({ ...DEFAULT_CONFIG, ...(input.config as Config) }),
      name: input.name,
      type: input.type,
    };
    return saved;
  });
  const agents = { create } as unknown as Agents;
  const view = render(
    <AgentCreateDialog
      agents={agents}
      types={[registeredType]}
      onCreated={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  const dialog = screen.getByRole("dialog", { name: "Create agent" });
  const user = userEvent.setup();
  await user.type(within(dialog).getByLabelText("Name"), "Nova");

  const model = within(dialog).getByRole("combobox", { name: "Model" });
  await waitFor(() => expect(model).toBeEnabled());
  await user.click(model);
  await user.click(await screen.findByRole("option", { name: "Sonnet 5.5" }));

  const thinking = within(dialog).getByRole("combobox", { name: "Thinking" });
  await waitFor(() => expect(thinking).toBeEnabled());
  await user.click(thinking);
  await user.click(await screen.findByRole("option", { name: "High" }));
  await user.click(
    within(dialog).getByRole("button", { name: "Create agent" }),
  );

  await waitFor(() => expect(create).toHaveBeenCalledOnce());
  expect(create).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "buzz.claude-code/claude-code",
      config: expect.objectContaining({ model: "sonnet", effort: "high" }),
    }),
  );
  expect(saved?.config).toMatchObject({ model: "sonnet", effort: "high" });

  view.unmount();
  const Settings = tab(type, 0);
  if (!saved) throw new Error("agent was not saved");
  render(<Settings agent={saved} save={vi.fn(async () => undefined)} />);
  expect(screen.getByRole("combobox", { name: "Thinking" })).toHaveTextContent(
    "High",
  );
});

it("returns Claude create-time effort to Default when the inherited model changes", async () => {
  const { type } = installed();
  function Controls() {
    const DefaultControl = type.provider?.DefaultControl;
    const Thinking = type.CreateThinking;
    if (!DefaultControl || !Thinking)
      throw new Error("Missing provider or create-time Thinking control");
    const [config, setConfig] = useState({ ...DEFAULT_CONFIG });
    return (
      <>
        <DefaultControl onConfigure={vi.fn()} />
        <Thinking config={config} onChange={setConfig} disabled={false} />
        <output data-testid="create-config">{JSON.stringify(config)}</output>
      </>
    );
  }
  render(<Controls />);
  const user = userEvent.setup();
  const providerModel = await screen.findByRole("button", {
    name: /^Claude default model:/,
  });
  await waitFor(() => {
    expect(providerModel).toHaveTextContent("Opus 5.5");
    expect(providerModel).toBeEnabled();
  });
  fireEvent.click(providerModel);
  fireEvent.click(await screen.findByRole("menuitem", { name: "Claude" }));
  fireEvent.click(
    await screen.findByRole("menuitemradio", { name: "Sonnet 5.5" }),
  );
  const sonnetEfforts = await screen.findByRole("menu", {
    name: "Sonnet 5.5 thinking effort",
  });
  fireEvent.click(
    within(sonnetEfforts).getByRole("menuitemradio", { name: "High" }),
  );
  await waitFor(() => expect(providerModel).toHaveTextContent("Sonnet 5.5"));

  const thinking = screen.getByRole("combobox", { name: "Thinking" });
  await waitFor(() => expect(thinking).toBeEnabled());
  await user.click(thinking);
  await user.click(await screen.findByRole("option", { name: "Extra high" }));
  expect(thinking).toHaveTextContent("Extra high");

  await waitFor(() => expect(providerModel).toBeEnabled());
  fireEvent.click(providerModel);
  fireEvent.click(await screen.findByRole("menuitem", { name: "Claude" }));
  fireEvent.click(
    await screen.findByRole("menuitemradio", { name: "Haiku 4.5" }),
  );
  const haikuEfforts = await screen.findByRole("menu", {
    name: "Haiku 4.5 thinking effort",
  });
  fireEvent.click(
    within(haikuEfforts).getByRole("menuitemradio", { name: "High" }),
  );
  await waitFor(() => expect(providerModel).toHaveTextContent("Haiku 4.5"));
  await waitFor(() =>
    expect(thinking).toHaveTextContent("Automatic · Default"),
  );
  expect(
    JSON.parse(screen.getByTestId("create-config").textContent ?? "null"),
  ).toMatchObject({ model: "", effort: "" });
});

it("clears a create-time Claude effort the newly selected model does not support", async () => {
  const Model = installed().type.CreateModel;
  if (!Model) throw new Error("Missing model control");
  const config = { ...DEFAULT_CONFIG, model: "sonnet", effort: "xhigh" };
  const onChange = vi.fn();
  render(<Model config={config} onChange={onChange} disabled={false} />);
  const control = await screen.findByRole("combobox", { name: "Model" });
  await waitFor(() => expect(control).toBeEnabled());

  const user = userEvent.setup();
  await user.click(control);
  await user.click(await screen.findByRole("option", { name: "Haiku 4.5" }));
  expect(onChange).toHaveBeenCalledWith({
    ...config,
    model: "haiku",
    effort: "",
  });
});

it("retains a create-time Claude effort supported by the selected model", async () => {
  const Model = installed().type.CreateModel;
  if (!Model) throw new Error("Missing model control");
  const config = { ...DEFAULT_CONFIG, model: "sonnet", effort: "high" };
  const onChange = vi.fn();
  render(<Model config={config} onChange={onChange} disabled={false} />);
  const control = await screen.findByRole("combobox", { name: "Model" });
  await waitFor(() => expect(control).toBeEnabled());

  const user = userEvent.setup();
  await user.click(control);
  await user.click(await screen.findByRole("option", { name: "Haiku 4.5" }));
  expect(onChange).toHaveBeenCalledWith({
    ...config,
    model: "haiku",
    effort: "high",
  });
});

it("clears inherited Claude effort when discovery omits its effective model", async () => {
  const storage = localStore();
  await new ClaudeDefaults(storage).save({
    model: "retired-model",
    effort: "xhigh",
  });
  const createThinking = installed({ storage }).type.CreateThinking;
  function Controls() {
    const Thinking = createThinking;
    if (!Thinking) throw new Error("Missing create-time Thinking control");
    const [config, setConfig] = useState({
      ...DEFAULT_CONFIG,
      effort: "xhigh",
    });
    return (
      <>
        <Thinking config={config} onChange={setConfig} disabled={false} />
        <output data-testid="create-config">{JSON.stringify(config)}</output>
      </>
    );
  }
  render(<Controls />);
  const thinking = await screen.findByRole("combobox", { name: "Thinking" });
  await waitFor(() => expect(thinking).toBeEnabled());
  await waitFor(() =>
    expect(
      JSON.parse(screen.getByTestId("create-config").textContent ?? "null"),
    ).toMatchObject({ model: "", effort: "" }),
  );

  await userEvent.setup().click(thinking);
  expect(
    (await screen.findAllByRole("option")).map((option) => option.textContent),
  ).toEqual(["Automatic · Default"]);
});

it("disables a new agent's controls while it is being created", () => {
  const Create = installed().type.Create;
  if (!Create) throw new Error("no create choices");
  render(<Create config={DEFAULT_CONFIG} onChange={vi.fn()} disabled />);
  expect(screen.getByLabelText("Instructions Optional")).toBeDisabled();
});

it("edits a custom model and instructions in settings", async () => {
  const Settings = tab(installed().type, 0);
  const save = vi.fn(async () => undefined);
  render(
    <Settings
      agent={agent({ ...DEFAULT_CONFIG, model: "claude-opus-4-1" })}
      save={save}
      settingsHost={{ typeControl: () => <p>Provider control</p> }}
    />,
  );
  const user = userEvent.setup();
  const providerControl = screen.getByText("Provider control");
  const modelControl = screen.getByRole("combobox", { name: "Model" });
  expect(
    providerControl.compareDocumentPosition(modelControl) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(modelControl).toHaveTextContent("claude-opus-4-1");
  expect(
    screen.getByLabelText("Instructions"),
  ).not.toHaveAccessibleDescription();
  await user.click(screen.getByRole("combobox", { name: "Model" }));
  await user.click(await screen.findByRole("option", { name: "Custom model" }));
  const modelId = await screen.findByRole("textbox", { name: "Model ID" });
  expect(modelId).toHaveValue("claude-opus-4-1");
  await user.clear(modelId);
  await user.type(modelId, "claude-sonnet-custom");
  await user.click(screen.getByRole("button", { name: "Use model" }));
  fireEvent.change(screen.getByLabelText("Instructions"), {
    target: { value: "Triage." },
  });
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(save).toHaveBeenCalledWith(
    {
      ...DEFAULT_CONFIG,
      model: "claude-sonnet-custom",
      instructions: "Triage.",
    },
    { base: {} },
  );
});

it("keeps settings editable while a provider change waits for Save", async () => {
  const Settings = tab(installed().type, 0);
  const save = vi.fn(async () => undefined);
  render(
    <Settings
      agent={agent()}
      save={save}
      settingsHost={{
        pendingSave: async () => {},
      }}
    />,
  );
  const user = userEvent.setup();
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled(),
  );
  expect(screen.getByRole("combobox", { name: "Model" })).toBeEnabled();
  expect(screen.getByRole("textbox", { name: "Workspace" })).toBeEnabled();
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(save).toHaveBeenCalledWith(DEFAULT_CONFIG, { base: {} });
});

it("shares one customization-free discovery across cards and workspace changes", async () => {
  const { type, spawn } = installed();
  const Model = type.CreateModel;
  if (!Model) throw new Error("Missing model field");
  const cards = (workspace: string) => (
    <StrictMode>
      {[1, 2, 3].map((id) => (
        <Model
          key={id}
          config={{ ...DEFAULT_CONFIG, workspace }}
          disabled={false}
          onChange={vi.fn()}
        />
      ))}
    </StrictMode>
  );
  const view = render(cards("/project-with-hooks"));
  await waitFor(() =>
    expect(screen.getAllByRole("combobox", { name: "Model" })).toHaveLength(3),
  );
  view.rerender(cards("/other-project"));
  view.unmount();
  render(cards("/third-project"));
  await screen.findAllByRole("combobox", { name: "Model" });
  const probes = spawn.mock.calls.filter(([, options]) =>
    options?.args?.includes("--input-format"),
  );
  expect(probes).toHaveLength(1);
  expect(probes[0]?.[1]).toMatchObject({
    cwd: "~",
    args: expect.arrayContaining([
      "--safe-mode",
      "--tools",
      "",
      "--strict-mcp-config",
    ]),
  });
  expect(probes[0]?.[1]?.args).not.toContain("bypassPermissions");
});

it("offers Set up Claude beside Harness when Claude is picked, then its models", async () => {
  const { type, navigation } = installed({ keySaved: false });
  const claude = {
    ...type,
    key: "buzz.claude-code/claude-code",
    pluginId: "buzz.claude-code",
    revision: "r1",
  } as unknown as RegisteredAgentType;
  const other = {
    key: "buzz.codex/codex",
    pluginId: "buzz.codex",
    revision: "r1",
    title: "Codex",
    defaults: () => ({ config: {} }),
  } as unknown as RegisteredAgentType;
  render(
    <ToastProvider>
      <AgentCreateDialog
        agents={{} as Agents}
        types={[other, claude]}
        onCreated={vi.fn()}
        onClose={vi.fn()}
      />
    </ToastProvider>,
  );
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Name"), "Nova");
  await choose("Harness", "Claude");
  const add = await screen.findByRole("button", { name: "Add Claude API key" });
  expect(add).toHaveTextContent("Add key");
  // Nothing opens by itself; Model and Thinking wait for the key.
  expect(screen.queryByRole("dialog", { name: "Set up Claude" })).toBeNull();
  expect(screen.getByRole("combobox", { name: "Model" })).toBeDisabled();
  expect(screen.getByRole("combobox", { name: "Thinking" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Create agent" })).toBeDisabled();

  // Closing setup keeps Claude picked.
  await user.click(add);
  await screen.findByRole("dialog", { name: "Set up Claude" });
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Set up Claude" })).toBeNull(),
  );
  expect(screen.getByRole("combobox", { name: "Harness" })).toHaveTextContent(
    "Claude",
  );

  await user.click(screen.getByRole("button", { name: "Add Claude API key" }));
  const dialog = await screen.findByRole("dialog", { name: "Set up Claude" });
  expect(
    within(dialog).getByText(
      "Claude requires an API key to connect to your account. Create one at console.anthropic.com and paste it below. You only have to set this up once, and Buzz keeps it securely on this computer.",
    ),
  ).toBeVisible();
  expect(within(dialog).queryByRole("button", { name: "Sign in" })).toBeNull();
  await user.type(
    within(dialog).getByLabelText("Anthropic API key"),
    "sk-ant-api03-pasted{Enter}",
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "Set up Claude" }),
    ).not.toBeInTheDocument(),
  );
  expect(
    screen.queryByRole("button", { name: "Add Claude API key" }),
  ).toBeNull();
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "Model" })).toBeEnabled(),
  );
  expect(await screen.findByText("Claude is set up")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Manage in Settings" }));
  expect(navigation.open).toHaveBeenCalledWith({
    version: 1,
    kind: "settings",
    section: "agents",
    provider: "buzz.claude-code/claude-code",
  });
});

it("holds a new Claude agent without a key, Model and Thinking disabled", async () => {
  const { type } = installed({ keySaved: false });
  const Configuration = type.CreateConfiguration;
  if (!Configuration) throw new Error("Missing creation configuration");
  const onReadyChange = vi.fn();
  render(
    <Configuration
      config={DEFAULT_CONFIG}
      disabled={false}
      harnessControl={<div>Harness row</div>}
      onReadyChange={onReadyChange}
      onChange={vi.fn()}
    />,
  );
  expect(screen.getByText("Harness row")).toBeVisible();
  expect(await screen.findByRole("combobox", { name: "Model" })).toBeDisabled();
  expect(screen.getByRole("combobox", { name: "Thinking" })).toBeDisabled();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(onReadyChange).toHaveBeenLastCalledWith(false);
});

it("offers an interactive sign-in in Set up Claude when the build has one", async () => {
  interactive.signIn = true;
  try {
    const { type } = installed({ keySaved: false });
    const Action = type.CreateAction;
    if (!Action) throw new Error("Missing creation action");
    render(
      <ToastProvider>
        <Action disabled={false} />
      </ToastProvider>,
    );
    const user = userEvent.setup();
    const open = await screen.findByRole("button", {
      name: "Add Claude API key",
    });
    expect(open).toHaveTextContent("Sign in");
    await user.click(open);
    const dialog = await screen.findByRole("dialog", { name: "Set up Claude" });
    await user.click(within(dialog).getByRole("button", { name: "Sign in" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Set up Claude" }),
      ).not.toBeInTheDocument(),
    );
    expect(await screen.findByText("Claude is set up")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Add Claude API key" }),
    ).toBeNull();
  } finally {
    interactive.signIn = false;
  }
});

it("stops a sign-in still running when Set up Claude closes", async () => {
  interactive.signIn = true;
  let release = () => {};
  interactive.hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const cancel = vi.spyOn(ClaudeSetup.prototype, "cancel");
  try {
    const { type } = installed({ keySaved: false });
    const Action = type.CreateAction;
    if (!Action) throw new Error("Missing creation action");
    render(<Action disabled={false} />);
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Add Claude API key" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Set up Claude" });
    await user.click(within(dialog).getByRole("button", { name: "Sign in" }));
    await waitFor(() =>
      expect(
        within(dialog).queryByRole("button", { name: "Sign in" }),
      ).toBeNull(),
    );
    expect(cancel).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Set up Claude" }),
      ).toBeNull(),
    );
    expect(cancel).toHaveBeenCalledTimes(1);
  } finally {
    release();
    interactive.hold = undefined;
    interactive.signIn = false;
    cancel.mockRestore();
  }
});

it("restores pending sign-in controls after unmount and can cancel and retry", async () => {
  interactive.signIn = true;
  interactive.process = true;
  const cancel = vi.spyOn(ClaudeSetup.prototype, "cancel");
  let view: ReturnType<typeof render> | undefined;
  const processes: { kill(): Promise<void> }[] = [];
  try {
    const { type, spawn } = installed({ keySaved: false });
    const Action = type.CreateAction;
    if (!Action) throw new Error("Missing creation action");
    const user = userEvent.setup();
    view = render(<Action disabled={false} />);
    await user.click(
      await screen.findByRole("button", { name: "Add Claude API key" }),
    );
    let dialog = await screen.findByRole("dialog", { name: "Set up Claude" });
    await user.click(within(dialog).getByRole("button", { name: "Sign in" }));
    const signIns = () =>
      spawn.mock.calls.filter(
        ([, options]) => options?.args?.slice(-2).join(" ") === "auth login",
      );
    await waitFor(() => expect(signIns()).toHaveLength(1));
    const index = spawn.mock.calls.findIndex(
      ([, options]) => options?.args?.slice(-2).join(" ") === "auth login",
    );
    const process = await spawn.mock.results[index]?.value;
    if (!process) throw new Error("Sign-in process missing");
    processes.push(process);
    const kill = vi.spyOn(process, "kill");
    view.unmount();
    expect(cancel).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();

    view = render(<Action disabled={false} />);
    dialog = await screen.findByRole("dialog", { name: "Set up Claude" });
    expect(
      within(dialog).queryByRole("button", { name: "Sign in" }),
    ).toBeNull();
    expect(signIns()).toHaveLength(1);
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await process.exited;
    expect(kill).toHaveBeenCalledTimes(1);
    await user.click(
      await within(dialog).findByRole("button", { name: "Sign in" }),
    );
    await waitFor(() => expect(signIns()).toHaveLength(2));
    const secondIndex = spawn.mock.calls.findIndex(
      ([, options], next) =>
        next > index && options?.args?.slice(-2).join(" ") === "auth login",
    );
    const secondProcess = await spawn.mock.results[secondIndex]?.value;
    if (!secondProcess) throw new Error("Second sign-in process missing");
    processes.push(secondProcess);
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await within(dialog).findByRole("button", { name: "Sign in" });
    expect(nativeKey.saved).toBe(false);
  } finally {
    for (const process of processes) await process.kill();
    view?.unmount();
    interactive.process = false;
    interactive.signIn = false;
    cancel.mockRestore();
  }
});

it("lets an agent on an execution target be edited without a key on this computer", async () => {
  const { type } = installed({ keySaved: false, remote: true });
  const Configuration = type.CreateConfiguration;
  const Action = type.CreateAction;
  if (!Configuration || !Action) throw new Error("Missing creation fields");
  const onReadyChange = vi.fn();
  const edited = { ...agent(), executionBinding: { provider: "nexus/blox" } };
  render(
    <>
      <Action agent={edited} disabled={false} />
      <Configuration
        agent={edited}
        config={DEFAULT_CONFIG}
        disabled={false}
        harnessControl={<div>Harness row</div>}
        onReadyChange={onReadyChange}
        onChange={vi.fn()}
      />
    </>,
  );
  await waitFor(() => expect(onReadyChange).toHaveBeenLastCalledWith(true));
  expect(screen.getByText("Model")).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Add Claude API key" }),
  ).toBeNull();
});

it("still asks for the key to edit an agent that runs on this computer", async () => {
  const { type } = installed({ keySaved: false });
  const Configuration = type.CreateConfiguration;
  const Action = type.CreateAction;
  if (!Configuration || !Action) throw new Error("Missing creation fields");
  const onReadyChange = vi.fn();
  render(
    <>
      <Action agent={agent()} disabled={false} />
      <Configuration
        agent={agent()}
        config={DEFAULT_CONFIG}
        disabled={false}
        harnessControl={<div>Harness row</div>}
        onReadyChange={onReadyChange}
        onChange={vi.fn()}
      />
    </>,
  );
  expect(
    await screen.findByRole("button", { name: "Add Claude API key" }),
  ).toBeVisible();
  expect(onReadyChange).toHaveBeenLastCalledWith(false);
});

it("sends a library card without a key to Claude's setup in Settings", async () => {
  const { type, navigation } = installed({ keySaved: false });
  const Model = type.CreateModel;
  if (!Model) throw new Error("Missing model field");
  render(
    <Model
      agent={agent()}
      modelAppearance="glass-ghost"
      config={DEFAULT_CONFIG}
      disabled={false}
      onChange={vi.fn()}
    />,
  );
  expect(
    await screen.findByText(/Claude is missing an API key\./),
  ).toBeVisible();
  expect(screen.queryByLabelText("Anthropic API key")).toBeNull();
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Settings" }));
  expect(navigation.open).toHaveBeenCalledWith({
    version: 1,
    kind: "settings",
    section: "agents",
    provider: "buzz.claude-code/claude-code",
  });
});

it("opens setup from a Model row without a key and closes it once one is saved", async () => {
  const { type } = installed({ keySaved: false });
  const Model = type.CreateModel;
  if (!Model) throw new Error("Missing model field");
  render(<Model config={DEFAULT_CONFIG} disabled={false} onChange={vi.fn()} />);
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("button", { name: "Add Claude API key" }),
  );
  const dialog = await screen.findByRole("dialog", { name: "Set up Claude" });
  await user.type(
    within(dialog).getByLabelText("Anthropic API key"),
    "sk-ant-api03-pasted{Enter}",
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "Set up Claude" }),
    ).not.toBeInTheDocument(),
  );
  expect(
    await screen.findByRole("combobox", { name: "Model" }),
  ).toBeInTheDocument();
});

it("offers an update before discovering models on a pre-safe-mode Claude copy", async () => {
  const { type, spawn } = installed({ version: "2.1.168" });
  const Model = type.CreateModel;
  if (!Model) throw new Error("Missing model field");
  render(<Model config={DEFAULT_CONFIG} disabled={false} onChange={vi.fn()} />);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Update Claude" })).toBeEnabled(),
  );
  expect(
    screen.queryByRole("button", { name: "Sign in" }),
  ).not.toBeInTheDocument();
  expect(
    spawn.mock.calls.filter(([, options]) =>
      options?.args?.includes("--safe-mode"),
    ),
  ).toHaveLength(0);
});

it("separates identity fields from runtime settings without changing the stored config", () => {
  const Settings = tab(installed().type, 0);
  const props = { agent: agent(), save: vi.fn(async () => undefined) };
  const view = render(<Settings {...props} settingsSection="identity" />);
  const instructions = screen.getByLabelText("Instructions");
  const model = screen.getByLabelText("Model");
  expect(
    model.compareDocumentPosition(instructions) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(screen.queryByLabelText("Workspace")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Sessions")).not.toBeInTheDocument();
  expect(screen.queryByText("Runtime diagnostics")).not.toBeInTheDocument();
  view.rerender(<Settings {...props} settingsSection="runtime" />);
  expect(screen.getByLabelText("Workspace")).toBeInTheDocument();
  expect(screen.getByLabelText("Sessions")).toBeInTheDocument();
  expect(screen.queryByText("Runtime diagnostics")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Instructions")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Model")).not.toBeInTheDocument();
  expect(props.save).not.toHaveBeenCalled();
});

it.each([
  { available: false, action: "Install Claude", title: "Set up Claude" },
])(
  "keeps failed Claude $action output in its open dialog",
  async ({ available, action, title }) => {
    const { type, spawn } = installed({ keySaved: false, available });
    const Model = type.CreateModel;
    if (!Model) throw new Error("Missing model field");
    render(
      <Model config={DEFAULT_CONFIG} disabled={false} onChange={vi.fn()} />,
    );
    const signIn = await screen.findByRole("button", { name: action });
    await waitFor(() => expect(signIn).toBeEnabled());
    const original = spawn.getMockImplementation();
    if (!original) throw new Error("Missing spawn implementation");
    spawn.mockImplementation(async (id, options = {}) => {
      if (options.args?.includes("install"))
        throw new Error("Setup could not start");
      return original(id, options);
    });
    fireEvent.click(signIn);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: action })).toBeEnabled(),
    );
    const dialog = await screen.findByRole("dialog", { name: title });
    fireEvent.click(
      await within(dialog).findByRole("button", { name: "Setup details" }),
    );
    expect(await within(dialog).findByRole("log")).toHaveTextContent(
      "Setup could not start",
    );
  },
);

it("keeps the shared Claude catalog across repeated provider checks", async () => {
  const { type, spawn } = installed();
  const Model = type.CreateModel;
  if (!Model || !type.provider) throw new Error("Missing provider");
  render(
    <>
      <Model config={DEFAULT_CONFIG} disabled={false} onChange={vi.fn()} />
      <Model config={DEFAULT_CONFIG} disabled={false} onChange={vi.fn()} />
    </>,
  );
  await screen.findAllByRole("combobox", { name: "Model" });
  for (let i = 0; i < 3; i++)
    await act(async () => {
      await type.provider?.check();
    });
  expect(
    spawn.mock.calls.filter(([, options]) =>
      options?.args?.includes("--input-format"),
    ),
  ).toHaveLength(1);
  expect(screen.getAllByRole("combobox", { name: "Model" })).toHaveLength(2);
});

it.each(["Identity", "Settings"])(
  "keeps editing after cancelling a tab switch and retries a failed save from %s",
  async (saveFrom) => {
    const f = installed();
    const Settings = tab(f.type, 0);
    const source = agent();
    const user = userEvent.setup();
    const savedAgent = { ...source, place: "here" as const };
    const save = vi
      .fn()
      .mockRejectedValueOnce(new Error("Save failed"))
      .mockResolvedValue(undefined);
    const agents = {
      save,
      configHistory: () => undefined,
      addedTabs: () => [],
      registerTab: () => {},
      controlAttention: () => {},
      memberships: () => [],
      subscribe: () => () => {},
    } as unknown as Agents;
    const type = {
      tabs: [
        {
          id: "settings",
          title: "Settings",
          role: "settings",
          splitSettings: true,
          component: Settings,
        },
      ],
    } as unknown as RegisteredAgentType;
    render(
      <AgentTabs
        agents={agents}
        agent={savedAgent}
        type={type}
        settingsHost={{}}
        channels={[]}
        memories={undefined}
        settingsContent={<p>Agent details</p>}
      />,
    );
    if (saveFrom === "Settings")
      await user.click(screen.getByRole("tab", { name: "Settings" }));
    const label = saveFrom === "Identity" ? "Instructions" : "Workspace";
    const value =
      saveFrom === "Identity" ? "Keep this identity draft." : "/tmp/kept-draft";
    await user.clear(screen.getByLabelText(label));
    await user.type(screen.getByLabelText(label), value);
    await user.click(screen.getByRole("tab", { name: "Memory" }));
    expect(await screen.findByRole("alertdialog")).toHaveTextContent(
      "unsaved changes will be lost",
    );
    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByLabelText(label)).toHaveValue(value);
    expect(screen.getAllByRole("button", { name: "Save" })).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Save failed");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(save).toHaveBeenLastCalledWith(savedAgent.pubkey, {
      base: {},
      config: expect.objectContaining({
        [saveFrom === "Identity" ? "instructions" : "workspace"]: value,
      }),
    });
  },
);

it("saves model-specific default effort from the nested menu and inherits it", async () => {
  const installedType = installed().type;
  const Control = installedType.provider?.DefaultControl;
  if (!Control) throw new Error("Missing default control");
  render(<Control onConfigure={vi.fn()} />);
  const control = await screen.findByRole("button", {
    name: /^Claude default model:/,
  });
  await waitFor(() => expect(control).toHaveTextContent("Opus 5.5"));
  expect(control).toHaveTextContent("Automatic");
  fireEvent.click(control);
  fireEvent.click(await screen.findByRole("menuitem", { name: "Claude" }));
  fireEvent.click(
    await screen.findByRole("menuitemradio", { name: "Sonnet 5.5" }),
  );
  fireEvent.click(await screen.findByRole("menuitemradio", { name: "High" }));
  await waitFor(() =>
    expect(control).toHaveAccessibleName(
      "Claude default model: Sonnet 5.5, High",
    ),
  );

  const reopened = new ClaudeDefaults(localStore());
  expect(reopened.resolve(DEFAULT_CONFIG)).toMatchObject({
    model: "sonnet",
    effort: "high",
  });
  expect(reopened.resolve({ ...DEFAULT_CONFIG, effort: "low" }).effort).toBe(
    "low",
  );
  expect(reopened.resolve({ ...DEFAULT_CONFIG, model: "haiku" }).effort).toBe(
    "",
  );
  fireEvent.click(control);
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "Use Claude default" }),
  );
  expect(new ClaudeDefaults(localStore()).snapshot().model).toBe("");
});

it("retries failed model discovery from the defaults row", async () => {
  const catalog = { listed: false };
  const Control = installed({ catalog }).type.provider?.DefaultControl;
  if (!Control) throw new Error("Missing default control");
  render(<Control onConfigure={vi.fn()} />);
  await screen.findByRole("alert");
  catalog.listed = true;
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: /^Claude default model:/ }),
    ).toHaveTextContent("Opus 5.5"),
  );
  expect(screen.queryByRole("alert")).toBeNull();
});

it("keeps the model inherited when changing the default model's effort", async () => {
  const Control = installed().type.provider?.DefaultControl;
  if (!Control) throw new Error("Missing default control");
  render(<Control onConfigure={vi.fn()} />);
  const control = await screen.findByRole("button", {
    name: /^Claude default model:/,
  });
  await waitFor(() => expect(control).toHaveTextContent("Opus 5.5 · Default"));
  fireEvent.click(control);
  fireEvent.click(await screen.findByRole("menuitem", { name: "Claude" }));
  fireEvent.click(
    await screen.findByRole("menuitemradio", { name: "Opus 5.5" }),
  );
  fireEvent.click(await screen.findByRole("menuitemradio", { name: "High" }));
  expect(new ClaudeDefaults(localStore()).snapshot()).toMatchObject({
    model: "",
    effort: "high",
  });
  expect(control).toHaveTextContent("· Default");
});

it("keeps keyboard focus through Claude defaults discovery retries", async () => {
  const startup = vi.spyOn(ClaudeSetup.prototype, "update");
  const calls = vi.spyOn(ClaudeSetup.prototype, "loadModels");
  const catalog: { listed: boolean; ready?: Promise<void> } = { listed: false };
  const Control = installed({ catalog }).type.provider?.DefaultControl;
  if (!Control) throw new Error("Missing default control");
  // Plugin activation checks/updates Claude before the recovery flow begins.
  // Its final readiness check otherwise races the keyboard retry.
  expect(startup).toHaveBeenCalledOnce();
  await startup.mock.results[0]?.value;
  render(<Control onConfigure={vi.fn()} />);
  await screen.findByRole("alert");
  const retry = screen.getByRole("button", { name: "Try again" });
  await act(async () => {
    await Promise.all(calls.mock.results.map((result) => result.value));
  });
  const user = userEvent.setup();
  for (const succeeds of [false, true]) {
    let release!: () => void;
    catalog.ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    catalog.listed = succeeds;
    await waitFor(() =>
      expect(retry).not.toHaveAttribute("aria-disabled", "true"),
    );
    retry.focus();
    const previousCalls = calls.mock.calls.length;
    try {
      await user.keyboard("{Enter}");
      await waitFor(() => {
        expect(calls.mock.calls.length).toBeGreaterThan(previousCalls);
        expect(retry).toHaveAttribute("aria-disabled", "true");
      });
      expect(retry).toHaveFocus();
      expect(retry).not.toHaveAttribute("disabled");
    } finally {
      await act(async () => release());
    }
    if (!succeeds) {
      await screen.findByRole("alert");
      expect(retry).toHaveFocus();
    }
  }
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(
    screen.getByRole("button", { name: /^Claude default model:/ }),
  ).toHaveFocus();
});

it("keeps same-channel recent threads visibly distinguishable", () => {
  localStorage.setItem(
    "buzz.claude-code.sessions.v1",
    JSON.stringify({
      [agent().key]: Object.fromEntries(
        ["e", "f"].map((char) => [
          `channel/${char.repeat(64)}`,
          { id: char, seen: 0, at: 1 },
        ]),
      ),
    }),
  );
  const Activity = tab(installed().type, 1);
  render(<Activity agent={agent()} save={vi.fn()} />);
  const rows = screen.getAllByRole("listitem");
  expect(rows).toHaveLength(2);
  expect(rows.map((row) => row.textContent)).toEqual(
    expect.arrayContaining([
      expect.stringContaining("Thread eeeeeeee"),
      expect.stringContaining("Thread ffffffff"),
    ]),
  );
});

it("clears unsupported saved effort when changing the creation model", async () => {
  const Model = installed().type.CreateModel;
  if (!Model) throw new Error("Missing model control");
  const config = { ...DEFAULT_CONFIG, model: "sonnet", effort: "xhigh" };
  const onChange = vi.fn();
  render(<Model config={config} onChange={onChange} disabled={false} />);
  const user = userEvent.setup();
  const picker = await screen.findByRole("combobox", { name: "Model" });
  await waitFor(() => expect(picker).toBeEnabled());
  await user.click(picker);
  await user.click(await screen.findByRole("option", { name: "Haiku 4.5" }));
  expect(onChange).toHaveBeenLastCalledWith({
    ...config,
    model: "haiku",
    effort: "",
  });
});

it("replaces the key through native code and keeps the result", async () => {
  const { saves, field, save, onClose } = await heldKeySaves();
  expect(field()).toHaveAttribute("type", "password");
  expect(save()).toHaveAttribute("aria-disabled", "true");
  const user = userEvent.setup();
  const key = "sk-ant-api03-secret";
  await user.type(field(), key);
  await user.click(save());
  await waitFor(() => expect(saves).toHaveLength(1));
  expect(nativeKey.saves).toEqual([key]);
  act(() => saves[0]?.settle());
  expect(await screen.findByText("Saved the Anthropic API key.")).toBeVisible();
  expect(field()).toHaveValue("");
  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));

  // A refused key's fixed line stays, with the pasted value kept to fix.
  await user.type(field(), "not-a-key");
  await user.click(save());
  await waitFor(() => expect(saves).toHaveLength(2));
  act(() => saves[1]?.settle("That is not an Anthropic API key."));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "That is not an Anthropic API key.",
  );
  expect(field()).toHaveValue("not-a-key");
  expect(onClose).toHaveBeenCalledTimes(1);
});

// Holds each native save until the test settles it.
async function heldKeySaves() {
  const { type } = installed();
  const Setup = providerSetup(type);
  const saves: { settle(refusal?: string): void }[] = [];
  nativeKey.save = (value) =>
    new Promise<void>((resolve, reject) => {
      saves.push({
        settle: (refusal) => (refusal ? reject(refusal) : resolve()),
      });
      void value;
    });
  const onClose = vi.fn();
  const view = render(<Setup onClose={onClose} />);
  expect(
    await screen.findByText("Claude runs with your Anthropic API key."),
  ).toBeVisible();
  return {
    view,
    saves,
    onClose,
    field: () => screen.getByLabelText("Replace API key"),
    save: () => screen.getByRole("button", { name: "Save key" }),
  };
}

it("keeps focus in the field through a save started there", async () => {
  const { saves, field } = await heldKeySaves();
  const user = userEvent.setup();
  await user.type(field(), "not-a-key");
  await user.keyboard("{Enter}");
  await waitFor(() => expect(saves).toHaveLength(1));
  // Natively disabled, a browser would drop its focus; jsdom does not.
  expect(field()).not.toBeDisabled();
  expect(field()).toHaveAttribute("readonly");
  expect(field()).toHaveAttribute("aria-disabled", "true");
  // A second Enter while saving starts nothing.
  await user.keyboard("{Enter}");
  act(() => saves[0]?.settle("That is not an Anthropic API key."));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "That is not an Anthropic API key.",
  );
  expect(saves).toHaveLength(1);
  expect(document.activeElement).toBe(field());
});

it("keeps focus on Save after a keyboard save clears the field", async () => {
  const { saves, field, save } = await heldKeySaves();
  const user = userEvent.setup();
  await user.type(field(), "sk-ant-api03-secret");
  await user.tab();
  expect(document.activeElement).toBe(save());
  await user.keyboard("{Enter}");
  await waitFor(() => expect(saves).toHaveLength(1));
  act(() => saves[0]?.settle());
  expect(await screen.findByText("Saved the Anthropic API key.")).toBeVisible();
  expect(field()).toHaveValue("");
  // Empty again, Save stays focusable: a browser drops a disabled one's focus.
  expect(save()).not.toBeDisabled();
  expect(save()).toHaveAttribute("aria-disabled", "true");
  expect(document.activeElement).toBe(save());
});

it("uses target model settings for remote Claude without a local catalog or a target allocation", async () => {
  const { type, spawn, execution } = installed({ remote: true });
  const Settings = tab(type, 0);
  const save = vi.fn(async () => {});
  render(<Settings agent={agent()} save={save} />);
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "Model" })).toHaveTextContent(
      "Target default",
    ),
  );
  expect(screen.getByLabelText("Workspace")).toBeDisabled();
  expect(
    screen.getByText("The execution provider sets the remote workspace."),
  ).toBeVisible();
  await userEvent
    .setup()
    .click(screen.getByRole("combobox", { name: "Model" }));
  expect(
    screen.queryByRole("option", { name: "Opus 5.5" }),
  ).not.toBeInTheDocument();
  expect(
    spawn.mock.calls.some(([, options]) =>
      options?.args?.includes("--input-format"),
    ),
  ).toBe(false);
  expect(execution).not.toHaveBeenCalled();
});

it("refreshes mounted Claude Settings after an execution binding changes", async () => {
  const f = installed();
  const Settings = tab(f.type, 0);
  const save = vi.fn(async () => {});
  const view = render(<Settings agent={agent()} save={save} />);
  await waitFor(() => expect(screen.getByLabelText("Workspace")).toBeEnabled());
  f.setRemote(true);
  view.rerender(
    <Settings
      agent={{ ...agent(), executionBinding: { provider: "nexus/blox" } }}
      save={save}
    />,
  );
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "Model" })).toHaveTextContent(
      "Target default",
    ),
  );
  expect(screen.getByLabelText("Workspace")).toBeDisabled();
  expect(f.execution).not.toHaveBeenCalled();
});

it("reports Claude connection readiness after resolving the provider default", async () => {
  const Model = installed().type.CreateModel;
  if (!Model) throw new Error("Missing model control");
  const onReadyChange = vi.fn();
  render(
    <Model
      config={DEFAULT_CONFIG}
      onChange={vi.fn()}
      onReadyChange={onReadyChange}
      disabled={false}
    />,
  );
  expect(onReadyChange).toHaveBeenCalledWith(false);
  await waitFor(() => expect(onReadyChange).toHaveBeenLastCalledWith(true));
});

/** Exercise the real settings tab through the host's revision and discard gates. */
function syncedSettings() {
  const installedType = installed().type;
  let source: Agent<Config> & {
    configBase: { settings: string; instructions: string };
  } = {
    ...agent(),
    place: "here" as const,
    configBase: { settings: "s0", instructions: "i0" },
  };
  const save = vi.fn(async (_key: string, _change: unknown) => {});
  const agents = {
    save,
    snapshot: () => ({ agents: [source] }),
    configHistory: () => undefined,
    addedTabs: () => [],
    subscribe: () => () => {},
    memberships: () => [],
  } as unknown as Agents;
  const type = {
    tabs: installedType.tabs?.filter((tab) => tab.role === "settings"),
  } as unknown as RegisteredAgentType;
  let pendingSave: ((config?: unknown) => Promise<void>) | undefined;
  const shown = () => (
    <StrictMode>
      <AgentTabs
        agents={agents}
        agent={source}
        type={type}
        settingsHost={pendingSave ? { pendingSave } : {}}
        channels={[]}
        memories={undefined}
        settingsContent={<p>Details</p>}
      />
    </StrictMode>
  );
  const view = render(shown());
  return {
    save,
    source: () => source,
    update(config: Config, base = source.configBase, problem?: string) {
      source = { ...source, config, configBase: base };
      if (problem) source = { ...source, configProblem: problem };
      else {
        const { configProblem: _problem, ...usable } = source;
        source = usable;
      }
      view.rerender(shown());
    },
    stage(save: (config?: unknown) => Promise<void>) {
      pendingSave = save;
      view.rerender(shown());
    },
  };
}

const editInstructions = (value: string) =>
  fireEvent.change(screen.getByLabelText("Instructions"), {
    target: { value },
  });

it("refreshes a clean Claude sidebar and saves unrelated edits against the merged revision", async () => {
  const f = syncedSettings();
  const config = { ...DEFAULT_CONFIG, model: "grid-model", effort: "low" };
  f.update(config, { settings: "s1", instructions: "i0" });
  expect(screen.getByRole("combobox", { name: "Model" })).toHaveTextContent(
    "grid-model",
  );
  expect(
    screen.queryByRole("button", { name: "Save" }),
  ).not.toBeInTheDocument();
  editInstructions("My edit");
  f.update(
    { ...config, model: "new-grid-model" },
    { settings: "s2", instructions: "i0" },
  );
  expect(screen.getByLabelText("Instructions")).toHaveValue("My edit");
  await userEvent.click(await screen.findByRole("button", { name: "Save" }));
  expect(f.save).toHaveBeenCalledWith(f.source().key, {
    config: { ...config, model: "new-grid-model", instructions: "My edit" },
    base: { settings: "s2", instructions: "i0" },
  });
});

it("blocks conflicting submission, preserves its discard guard, and keeps the explicit choice", async () => {
  const f = syncedSettings();
  editInstructions("Mine");
  const config = { ...DEFAULT_CONFIG, instructions: "Theirs" };
  f.update(config, { settings: "s0", instructions: "i1" });
  f.update(
    { ...config, model: "grid-model" },
    { settings: "s1", instructions: "i1" },
  );
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Instructions changed elsewhere",
  );
  const form = screen.getByLabelText("Instructions").closest("form");
  if (!form) throw new Error("Missing form");
  fireEvent.submit(form);
  expect(f.save).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("tab", { name: "Settings" }));
  expect(await screen.findByRole("alertdialog")).toHaveTextContent(
    "unsaved changes",
  );
  await userEvent.click(screen.getByRole("button", { name: "Keep editing" }));
  await userEvent.click(screen.getByRole("button", { name: "Keep mine" }));
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(f.save).toHaveBeenCalledWith(f.source().key, {
    config: { ...config, model: "grid-model", instructions: "Mine" },
    base: { settings: "s1", instructions: "i1" },
  });
});

it("reconciles a partial failed save and preserves a newer edit through retry", async () => {
  const f = syncedSettings();
  let rejectSave!: (reason: Error) => void;
  const pending = new Promise<void>((_resolve, reject) => {
    rejectSave = reject;
  });
  f.save.mockImplementationOnce(() => pending);
  await choose("Model", "Sonnet 5.5");
  editInstructions("Submitted");
  await userEvent.click(await screen.findByRole("button", { name: "Save" }));
  expect(f.save).toHaveBeenCalledTimes(1);
  try {
    editInstructions("Newer edit");
    f.update(
      { ...DEFAULT_CONFIG, instructions: "Submitted" },
      { settings: "s0", instructions: "i1" },
    );
    expect(screen.getByLabelText("Instructions")).toHaveValue("Newer edit");
    expect(screen.queryByText(/changed elsewhere/)).not.toBeInTheDocument();
  } finally {
    await act(async () => rejectSave(new Error("Settings could not save")));
  }
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Settings could not save",
  );
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(f.save).toHaveBeenLastCalledWith(f.source().key, {
    config: { ...DEFAULT_CONFIG, model: "sonnet", instructions: "Newer edit" },
    base: { settings: "s0", instructions: "i1" },
  });
});

it("uses staged provider saving, retaining its draft after failure", async () => {
  const f = syncedSettings();
  const pendingSave = vi
    .fn()
    .mockRejectedValueOnce(new Error("Provider failed"))
    .mockResolvedValue(undefined);
  f.stage(pendingSave);
  editInstructions("Staged edit");
  await userEvent.click(await screen.findByRole("button", { name: "Save" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Provider failed");
  // A new pendingSave callback from the host is not a new saved configuration.
  f.stage((config) => pendingSave(config));
  expect(screen.getByLabelText("Instructions")).toHaveValue("Staged edit");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(pendingSave).toHaveBeenLastCalledWith({
    ...DEFAULT_CONFIG,
    instructions: "Staged edit",
  });
  expect(f.save).not.toHaveBeenCalled();
});

it("preserves settings through config unavailability and resumes against the recovered revision", async () => {
  const f = syncedSettings();
  f.update({ ...DEFAULT_CONFIG, model: "kept-model" });
  editInstructions("Keep this draft");
  f.update(
    DEFAULT_CONFIG,
    { settings: "s0", instructions: "i0" },
    "Config unavailable",
  );
  expect(screen.getByRole("combobox", { name: "Model" })).toHaveTextContent(
    "kept-model",
  );
  expect(screen.getByLabelText("Instructions")).toHaveValue("Keep this draft");
  expect(screen.getByRole("alert")).toHaveTextContent("Config unavailable");
  expect(
    screen.getByText(/You can save them, including Workspace/),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Save" }),
  ).not.toBeInTheDocument();
  f.update(
    { ...DEFAULT_CONFIG, model: "recovered-model" },
    { settings: "s2", instructions: "i0" },
  );
  expect(
    screen.queryByText(/You can save them, including Workspace/),
  ).not.toBeInTheDocument();
  await userEvent.click(await screen.findByRole("button", { name: "Save" }));
  expect(f.save).toHaveBeenLastCalledWith(f.source().key, {
    config: {
      ...DEFAULT_CONFIG,
      model: "recovered-model",
      instructions: "Keep this draft",
    },
    base: { settings: "s2", instructions: "i0" },
  });
});

it("can stage Claude over an unavailable source config, retry, and discard through the real host", async () => {
  const Settings = tab(installed().type, 0);
  const sourceType: RegisteredAgentType = {
    key: "fixture/source",
    pluginId: "fixture",
    revision: "1",
    id: "source",
    title: "Source",
    defaults: () => ({ config: {} }),
  };
  const target = {
    ...sourceType,
    key: "fixture/claude",
    id: "claude",
    title: "Claude",
    tabs: [
      {
        id: "settings",
        title: "Settings",
        role: "settings",
        component: Settings,
      },
    ],
  } as unknown as RegisteredAgentType;
  const source: Agent = {
    ...agent(),
    place: "here",
    type: sourceType.key,
    configProblem: "Source settings are unavailable",
  };
  const retype = vi
    .fn()
    .mockRejectedValueOnce(new Error("Migration failed"))
    .mockResolvedValue(undefined);
  const save = vi.fn();
  const agents = {
    previewRetype: () => ({
      config: DEFAULT_CONFIG,
      moved: [],
      dropped: [],
      settings: [],
    }),
    retype,
    save,
    configHistory: () => undefined,
    addedTabs: () => [],
  } as unknown as Agents;
  function Host() {
    const host = useAgentSettingsHost({
      agents,
      agent: source,
      type: sourceType,
      types: [sourceType, target],
    });
    return (
      <AgentTabs
        agents={agents}
        agent={host.agent}
        type={host.type}
        settingsHost={host.settingsHost}
        onDiscard={host.discard}
        channels={[]}
        memories={undefined}
        settingsContent={<p>Management</p>}
      />
    );
  }
  render(<Host />);
  const user = userEvent.setup();
  await user.click(
    screen.getByRole("button", { name: "Change harness from Source" }),
  );
  await user.click(
    await screen.findByRole("menuitemradio", { name: "Claude" }),
  );
  await user.click(await screen.findByRole("button", { name: "Continue" }));
  editInstructions("Staged Claude instructions");
  await user.click(await screen.findByRole("button", { name: "Save" }));
  expect(await screen.findByText("Migration failed")).toBeVisible();
  expect(screen.getByLabelText("Instructions")).toHaveValue(
    "Staged Claude instructions",
  );
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(retype).toHaveBeenLastCalledWith(source.key, target.key, {
    config: { ...DEFAULT_CONFIG, instructions: "Staged Claude instructions" },
  });
  expect(save).not.toHaveBeenCalled();

  // Restage, then use the existing navigation guard to discard the destination.
  await user.click(
    screen.getByRole("button", { name: "Change harness from Source" }),
  );
  await user.click(
    await screen.findByRole("menuitemradio", { name: "Claude" }),
  );
  await user.click(await screen.findByRole("button", { name: "Continue" }));
  editInstructions("Discard this");
  await user.click(screen.getByRole("tab", { name: "Settings" }));
  await user.click(
    await screen.findByRole("button", { name: "Discard changes" }),
  );
  await user.click(screen.getByRole("tab", { name: "Identity" }));
  expect(
    screen.getByRole("button", { name: "Change harness from Source" }),
  ).toBeVisible();
  expect(screen.queryByLabelText("Instructions")).not.toBeInTheDocument();
  expect(retype).toHaveBeenCalledTimes(2);
});

it.each([false, true])(
  "warns before navigation when reverting around uncertain settlement (revertAfter=%s)",
  async (revertAfter) => {
    const f = syncedSettings();
    let rejectSave!: (reason: Error) => void;
    const pending = new Promise<void>((_resolve, reject) => {
      rejectSave = reject;
    });
    f.save.mockImplementationOnce(() => pending);
    editInstructions("Submitted");
    await userEvent.click(await screen.findByRole("button", { name: "Save" }));
    try {
      expect(f.save).toHaveBeenCalledTimes(1);
      if (!revertAfter) editInstructions("");
    } finally {
      await act(async () => rejectSave(new Error("Save outcome is unknown")));
    }
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Save outcome is unknown",
    );
    if (revertAfter) editInstructions("");
    // Retrying the original value may be a successful no-op against the local
    // snapshot; it does not disprove the earlier uncertain publication.
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(f.save).toHaveBeenCalledTimes(2);
    await userEvent.click(screen.getByRole("tab", { name: "Settings" }));
    expect(await screen.findByRole("alertdialog")).toHaveTextContent(
      "unsaved changes",
    );
    await userEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    f.update({ ...DEFAULT_CONFIG, instructions: "Other device" });
    expect(screen.getByLabelText("Instructions")).toHaveValue("");
    expect(
      screen.getByRole("group", { name: "Instructions conflict" }),
    ).toHaveTextContent("Instructions changed elsewhere");
  },
);

it("places separate conflict choices beside their fields and shows the competing values", async () => {
  const f = syncedSettings();
  await choose("Model", "Sonnet 5.5");
  editInstructions("My instructions");
  f.update({
    ...DEFAULT_CONFIG,
    model: "opus",
    effort: "high",
    instructions: "Latest instructions\nSecond line",
  });
  const modelConflict = screen.getByRole("group", {
    name: "Model and thinking conflict",
  });
  expect(modelConflict).toHaveTextContent(/Latest:.*Opus.*High thinking/);
  expect(modelConflict).toHaveTextContent(
    /Yours:.*Sonnet 5.5.*Automatic thinking/,
  );
  expect(modelConflict.parentElement).toContainElement(
    screen.getByRole("combobox", { name: "Model" }),
  );
  const instructionsConflict = screen.getByRole("group", {
    name: "Instructions conflict",
  });
  expect(instructionsConflict.parentElement).toContainElement(
    screen.getByLabelText("Instructions"),
  );
  await userEvent.click(
    within(instructionsConflict).getByRole("button", {
      name: "View latest instructions",
    }),
  );
  expect(
    within(instructionsConflict).getByText(/Latest instructions/),
  ).toHaveTextContent("Second line");
  await userEvent.click(
    within(modelConflict).getByRole("button", { name: "Use latest" }),
  );
  expect(
    screen.queryByRole("group", { name: "Model and thinking conflict" }),
  ).not.toBeInTheDocument();
  expect(instructionsConflict).toBeInTheDocument();
  await userEvent.click(
    within(instructionsConflict).getByRole("button", { name: "Keep mine" }),
  );
  expect(screen.getByLabelText("Instructions")).toHaveValue("My instructions");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(f.save).toHaveBeenLastCalledWith(f.source().key, {
    config: {
      ...DEFAULT_CONFIG,
      model: "opus",
      effort: "high",
      instructions: "My instructions",
    },
    base: { settings: "s0", instructions: "i0" },
  });
});
