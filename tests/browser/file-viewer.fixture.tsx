import { useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  AttachmentRenderer,
  FileCardProps,
} from "../../src/features/conversation/contracts";
import { FileAttachment } from "../../src/features/messages/FileAttachment";
import type { Attachment } from "../../src/features/relay/contracts";
import type { Panel } from "../../src/features/panels/service";
import { apply } from "../../src/bundled/file-viewer";
import { ToastProvider } from "../../src/shared/design-system/ui/Toast";
import "../../src/shared/styles/globals.css";

// The real plugin over a fake relay: its file card wraps the host's
// FileAttachment, and its panel reads files the spec serves at the relay media
// proxy path. Nothing here signs or reaches a relay.
const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle(
  "dark",
  params.get("theme") === "dark",
);
document.documentElement.dataset.colorMode =
  params.get("theme") === "dark" ? "dark" : "light";
if (params.has("large")) document.documentElement.style.fontSize = "150%";

const ORIGIN = "https://relay.example.org";
const media = (hash: string) => `${ORIGIN}/media/${hash.repeat(64)}`;
const snapshot = {
  status: "ready",
  generation: 1,
  origin: ORIGIN,
  session: {
    media: (url: string) => `/api/relay/media?url=${encodeURIComponent(url)}`,
  },
};
let panel: Panel | undefined;
let renderer: AttachmentRenderer | undefined;
apply({
  relay: { snapshot: () => snapshot, subscribe: () => () => {} },
  conversation: {
    registerAttachment: (entry: AttachmentRenderer) => {
      renderer = entry;
    },
  },
  panels: {
    register: (entry: Panel) => {
      panel = entry;
    },
  },
} as unknown as Parameters<typeof apply>[0]);

const FILES: Attachment[] = [
  { url: media("a"), kind: "file", name: "notes.md", mime: "text/markdown" },
  { url: media("b"), kind: "file", name: "rows.csv", mime: "text/csv" },
  { url: media("c"), kind: "file", name: "main.rs" },
  { url: media("d"), kind: "file", name: "guide.pdf", mime: "application/pdf" },
  { url: media("e"), kind: "file", name: "archive.zip" },
];
// Files a spec asks for with `?extra=<name>`, so the shared list stays short.
const EXTRA: Record<string, Attachment> = {
  japanese: {
    url: media("f"),
    kind: "file",
    name: "japanese.pdf",
    mime: "application/pdf",
  },
  long: { url: media("1"), kind: "file", name: "long.md" },
  pictures: { url: media("2"), kind: "file", name: "pictures.md" },
  blank: { url: media("3"), kind: "file", name: "blank.pdf" },
};
for (const name of params.getAll("extra")) {
  const extra = EXTRA[name];
  if (extra) FILES.push(extra);
}

const HostFileCard = (props: FileCardProps) => <FileAttachment {...props} />;

let opened: (target: string) => void = () => {};
function Fixture() {
  const [target, setTarget] = useState<string>();
  opened = setTarget;
  const Panel = panel?.component;
  const Card = renderer?.component;
  return (
    <div className="layout">
      <main aria-label="Message">
        {FILES.map((file) =>
          Card && renderer?.matches(file) ? (
            <Card
              key={file.url}
              attachment={file}
              source={snapshot.session.media(file.url)}
              placement="message"
              FileCard={HostFileCard}
              canOpen={() => true}
              open={(next) => {
                if (!panel?.matches(next)) return false;
                opened(next);
                return true;
              }}
            />
          ) : (
            <p key={file.url}>Not claimed: {file.name}</p>
          ),
        )}
      </main>
      {Panel && target && (
        <aside aria-label="File viewer">
          <Panel
            key={target}
            target={target}
            close={() => setTarget(undefined)}
          />
        </aside>
      )}
    </div>
  );
}

const style = document.createElement("style");
style.textContent = `
  body { background: var(--surface-canvas); color: var(--text-standard); margin: 0; }
  .layout { display: flex; flex-wrap: wrap; gap: 16px; padding: 16px; height: 100vh; box-sizing: border-box; }
  .layout > main { flex: 1 1 280px; min-width: 0; display: grid; gap: 8px; align-content: start; }
  .layout > aside { flex: 2 1 360px; min-width: 0; height: calc(100vh - 32px);
    border: 1px solid var(--border-standard); }
`;
document.head.append(style);
const root = document.getElementById("root");
if (!root) throw new Error("Missing root");
createRoot(root).render(
  <ToastProvider>
    <Fixture />
  </ToastProvider>,
);
