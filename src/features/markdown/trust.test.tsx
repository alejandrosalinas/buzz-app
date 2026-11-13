// @vitest-environment jsdom
// Each screen's raw-HTML, image and URL policy, recorded before the shared
// renderer existed. Only Attention changes: it gained GFM autolinks.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, expect, it } from "vitest";
import { PluginReadme } from "../../app/PluginReadme";
import { CanvasMarkdown } from "../../bundled/channels/CanvasView";
import { GitHubBody } from "../../bundled/github/GitHubBody";
import { Body as RepoBody } from "../../bundled/repos/RepoPage";
import {
  InstructionsMarkdown,
  OpenLink,
} from "../../bundled/watching/InstructionsMarkdown";
import { ActivityTranscript } from "../agents/ActivityTranscript";
import { activityTranscript } from "../agents/activity-transcript";
import { createAgentMemories } from "../agents/memory";
import { MemoryPanel } from "../agents/MemoryPanel";
import type { Agent } from "../agents/service";
import { ToastProvider } from "../../shared/design-system/ui/Toast";

afterEach(cleanup);

const PROFILE =
  "nostr:npub1vujjkzwrr2v4m2nr4tdzv45lh34r6yh4wvgn7qquuapjlpcd4qsqkjn5uw";
const agent = "a".repeat(64);

/** An agent reply, as the transcript shows it. */
function transcript(text: string) {
  const at = "2026-11-04T12:00:00.000Z";
  const frame = (seq: number, kind: string, payload: unknown = {}) => ({
    seq,
    timestamp: at,
    kind,
    agentIndex: 0,
    channelId: null,
    sessionId: "S",
    turnId: "t1",
    payload,
  });
  const events = [
    frame(0, "turn_started"),
    frame(1, "acp_read", {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "S",
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "m1",
          content: { type: "text", text },
        },
      },
    }),
    frame(2, "turn_completed", { outcome: "completed" }),
  ];
  return activityTranscript(
    [
      {
        id: "1".padStart(64, "0"),
        agent,
        receivedAt: Date.parse(at),
        plaintext: JSON.stringify({ kind: "batch", payload: { events } }),
      },
    ],
    { agent },
  );
}

function memories(body: string) {
  return createAgentMemories(
    async () => ({
      entries: [{ slug: "core", body, eventId: "b".repeat(64), createdAt: 1 }],
      partial: false,
    }),
    "c".repeat(64),
    () => true,
  ).capability;
}

const INPUTS = {
  html: "<script>alert(1)</script> and <mark>x</mark>",
  javascript: "[a](javascript:alert(1))",
  data: "[a](data:text/html,x)",
  vbscript: "[a](vbscript:x)",
  credentialed: "[a](https://u:p@example.com/)",
  relative: "[a](docs/page) [b](#part)",
  mailto: "[a](mailto:me@example.com)",
  buzz: "[a](buzz://channel/general)",
  profile: `[a](${PROFILE})`,
  image: "![alt](https://example.com/a.png)",
  autolink: "see https://example.com/x",
};
const SCREENS: Record<string, (content: string) => ReactElement> = {
  canvas: (content) => (
    <CanvasMarkdown content={content} openLink={() => false} />
  ),
  pluginReadme: (content) => <PluginReadme text={content} />,
  github: (content) => (
    <GitHubBody body={content} url="https://github.com/o/r/pull/1" />
  ),
  attention: (content) => <InstructionsMarkdown text={content} />,
  repo: (content) => (
    <RepoBody
      text={content}
      open={async () => ({ status: "opened" }) as const}
      scope={{ viewer: agent, communityOrigin: "https://example.com" }}
    />
  ),
  memory: (content) => (
    <MemoryPanel
      agent={{ pubkey: agent, name: "Ada", place: "here" } as Agent}
      memories={memories(content)}
      agents={{ subscribe: () => () => {}, memberships: () => [] }}
    />
  ),
  transcript: (content) => (
    <ActivityTranscript
      transcript={transcript(content)}
      agentName="Ada"
      state={() => "ended"}
      follow={false}
    />
  ),
};
/** Screens whose Markdown sits inside other content, read from there. */
const BODIES: Record<string, string> = {
  memory: '[class*="markdown"]',
  transcript: '[class*="markdown"]',
};

async function observe(screenName: string, element: ReactElement) {
  const { container } = render(element, { wrapper: ToastProvider });
  if (screenName === "memory")
    fireEvent.click(await screen.findByRole("button", { name: "core" }));
  const selector = BODIES[screenName];
  const root = selector
    ? (((await screen.findAllByText(() => true)) &&
        container.querySelector(selector)) ??
      container)
    : container;
  const record = {
    elements: ["script", "mark", "img"]
      .filter((tag) => root.querySelector(tag))
      .join(" "),
    text: root.textContent?.replace(/\s+/g, " ").trim(),
    links: [...root.querySelectorAll("a, button[class]")].map(
      (link) => link.getAttribute("href") ?? `<${link.tagName.toLowerCase()}>`,
    ),
  };
  cleanup();
  return record;
}

const RAW = "<script>alert(1)</script> and <mark>x</mark>";
const AUTO = "https://example.com/x";
const CRED = "https://u:p@example.com/";
const MAIL = "mailto:me@example.com";
const BUZZ = "buzz://channel/general";
/**
 * What each screen shows for raw HTML and images, and the href of every link
 * it keeps per input (an omitted input keeps none; "" is a disabled link).
 */
const EXPECTED: Record<
  string,
  { html: string; image: "alt" | "img"; links: Record<string, string[]> }
> = {
  canvas: {
    html: RAW,
    image: "alt",
    links: { buzz: [BUZZ], autolink: [AUTO] },
  },
  pluginReadme: { html: "", image: "alt", links: { autolink: [AUTO] } },
  github: {
    html: "alert(1) and x",
    image: "alt",
    links: {
      relative: [
        "https://github.com/o/r/pull/docs/page",
        "https://github.com/o/r/pull/1#part",
      ],
      image: ["https://example.com/a.png"],
      autolink: [AUTO],
    },
  },
  attention: {
    html: RAW,
    image: "alt",
    links: {
      credentialed: [CRED],
      relative: ["#part"],
      mailto: [MAIL],
      buzz: [BUZZ],
      autolink: [AUTO],
    },
  },
  repo: {
    html: RAW,
    image: "img",
    links: {
      javascript: [""],
      data: [""],
      vbscript: [""],
      credentialed: [CRED],
      relative: ["", ""],
      mailto: [MAIL],
      buzz: [BUZZ],
      profile: [""],
      autolink: [AUTO],
    },
  },
  memory: {
    html: RAW,
    image: "alt",
    links: {
      credentialed: [CRED],
      relative: ["docs/page", "#part"],
      mailto: [MAIL],
      buzz: [BUZZ],
      autolink: [AUTO],
    },
  },
  transcript: {
    html: RAW,
    image: "alt",
    links: {
      credentialed: [CRED],
      relative: ["docs/page", "#part"],
      mailto: [MAIL],
      autolink: [AUTO],
    },
  },
};

function expected(screenName: string, input: string) {
  const entry = EXPECTED[screenName];
  if (!entry) throw new Error(`no expectation for ${screenName}`);
  const { html, image, links } = entry;
  const text =
    input === "html"
      ? html
      : input === "image"
        ? image === "img"
          ? ""
          : "alt"
        : input === "relative"
          ? "a b"
          : input === "autolink"
            ? `see ${AUTO}`
            : "a";
  const elements = input === "image" && image === "img" ? "img" : "";
  return { elements, text, links: links[input] ?? [] };
}

it("keeps each screen's trust policy", async () => {
  for (const [screenName, draw] of Object.entries(SCREENS))
    for (const [name, input] of Object.entries(INPUTS))
      expect(
        await observe(screenName, draw(input)),
        `${screenName} ${name}`,
      ).toEqual(expected(screenName, name));
});

// Only Attention routes profile links; the other screens drop or keep them as
// listed in EXPECTED.
it("routes a valid profile link through Attention's host", () => {
  const opened: string[] = [];
  render(
    <OpenLink.Provider
      value={{ open: (url) => opened.push(url) > 0, canOpen: () => true }}
    >
      <InstructionsMarkdown text={`[Ada](${PROFILE})`} />
    </OpenLink.Provider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Ada" }));
  expect(opened).toEqual([PROFILE]);
});
