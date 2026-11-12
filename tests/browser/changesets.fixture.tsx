import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { ComposerAccessoryProps } from "../../src/features/conversation/contracts";
import type { LocalWork } from "../../src/features/agents/local-activity";
import type { RelaySession } from "../../src/features/relay/session";
import { TurnCards } from "../../src/bundled/changesets/Card";
import type { Git } from "../../src/bundled/changesets/git";
import { ChangesetPanel } from "../../src/bundled/changesets/Panel";
import { createTurns } from "../../src/bundled/changesets/turns";
import "../../src/shared/styles/globals.css";

// The real card, panel, Diff viewer and turn store over a scripted git: the
// store is seeded with one finished turn, and `git` answers the few diff
// commands the card and panel make. Nothing here runs git or a native host.
const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle(
  "dark",
  params.get("theme") === "dark",
);
if (params.has("large")) document.documentElement.style.fontSize = "150%";

const LOCAL = "a".repeat(64);
const REMOTE = "b".repeat(64);
const now = Date.now();
const checkout = {
  dir: "/Users/me/app",
  prefix: "",
  label: "app (main)",
  before: "a".repeat(40),
  after: "b".repeat(40),
  files: 3,
};
const storage = {
  getItem: () =>
    JSON.stringify([
      {
        id: "t1",
        agent: LOCAL,
        channelId: "chat",
        viewer: "me",
        origin: "https://relay.example",
        start: now - 60_000,
        end: now - 30_000,
        message: { id: "reply", at: now - 31_000 },
        checkouts: [checkout],
      },
    ]),
  setItem: () => {},
} as unknown as Storage;

const PATCHES: Record<string, string> = {
  "src/app.ts": [
    "diff --git a/src/app.ts b/src/app.ts",
    "index 1111111..2222222 100644",
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    "@@ -1,5 +1,6 @@",
    " import { run } from './run';",
    "-const retries = 1;",
    "+const retries = 3;",
    "+const delay = 250;",
    " export function start() {",
    "-  return run(retries);",
    "+  return run(retries, delay);",
    " }",
    "",
  ].join("\n"),
  "src/new.ts": [
    "diff --git a/src/new.ts b/src/new.ts",
    "new file mode 100644",
    "index 0000000..3333333",
    "--- /dev/null",
    "+++ b/src/new.ts",
    "@@ -0,0 +1,2 @@",
    "+export const answer = 42;",
    "+export const question = 'unknown';",
    "",
  ].join("\n"),
};
const calls: string[][] = [];
(window as unknown as { gitCalls: string[][] }).gitCalls = calls;
const git: Git = async (args) => {
  calls.push([...args]);
  if (args.includes("--name-status"))
    return "M\0src/app.ts\0A\0src/new.ts\0M\0logo.png\0";
  if (args.includes("--numstat"))
    return "3\t2\tsrc/app.ts\0" + "2\t0\tsrc/new.ts\0" + "-\t-\tlogo.png\0";
  if (args.includes("--patch")) {
    const path = String(args.at(-1)).replace(":(top,literal)", "");
    return PATCHES[path] ?? "";
  }
  throw new Error("This fixture's git only reads diffs.");
};

const listeners = new Set<() => void>();
let local: LocalWork[] = [];
const session = {
  viewer: "me",
  canvas: {},
  agentChoices: {
    snapshot: () => ({
      identities: [
        { pubkey: LOCAL, execution: "local" },
        { pubkey: REMOTE, execution: "remote" },
      ],
    }),
  },
  agentActivity: {
    activate: () => () => {},
    snapshot: () => ({ local }),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  },
} as unknown as RelaySession;
const turns = createTurns(git, storage);
turns.watch(session, "https://relay.example");

const remoteTurn = (state: LocalWork["state"]) => {
  local = [
    {
      scope: "s",
      agent: REMOTE,
      channelId: "chat",
      messageId: "req",
      threadRootId: "",
      state,
      startedAt: now,
    },
  ];
  for (const listener of listeners) listener();
};
Object.assign(window, {
  async runRemoteTurn() {
    remoteTurn("working");
    remoteTurn("done");
    await new Promise((settle) => setTimeout(settle, 0));
  },
});

const message = (id: string, authorId: string) =>
  ({
    id,
    authorId,
    channelId: "chat",
    createdAt: Math.floor((now - 31_000) / 1000),
    createdAtMs: now - 31_000,
  }) as ComposerAccessoryProps["message"];

function Row({
  id,
  author,
  name,
}: {
  id: string;
  author: string;
  name: string;
}) {
  return (
    <article aria-label={`${name}'s reply`}>
      <p>
        <strong>{name}</strong>: I updated the retry settings.
      </p>
      <TurnCards
        {...({
          message: message(id, author),
          canOpen: () => true,
          open: (target: string) => {
            opened(target);
            return true;
          },
        } as unknown as ComposerAccessoryProps)}
        turns={turns}
      />
    </article>
  );
}

let opened: (target: string) => void = () => {};
function Fixture() {
  const [target, setTarget] = useState<string>();
  opened = setTarget;
  return (
    <div className="layout">
      <main>
        <Row id="reply" author={LOCAL} name="Local agent" />
        <Row id="remote-reply" author={REMOTE} name="Remote agent" />
      </main>
      {target && (
        <aside aria-label="Changes">
          <ChangesetPanel target={target} turns={turns} />
        </aside>
      )}
    </div>
  );
}

const style = document.createElement("style");
style.textContent = `
  body { background: var(--surface-canvas); color: var(--text-standard); margin: 0; }
  .layout { display: flex; flex-wrap: wrap; gap: 16px; padding: 16px; }
  .layout > main { flex: 1 1 320px; min-width: 0; }
  .layout > aside { flex: 2 1 360px; min-width: 0; background: var(--surface-panel);
    border: 1px solid var(--border-standard); padding: 16px; }
`;
document.head.append(style);
const root = document.getElementById("root");
if (!root) throw new Error("Missing root");
createRoot(root).render(<Fixture />);
