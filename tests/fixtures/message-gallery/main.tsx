import { ToastProvider } from "../../../src/shared/design-system/ui/Toast";
import "../../../src/shared/styles/globals.css";
import "@fontsource-variable/inter/wght.css";
import "@fontsource/jetbrains-mono/400.css";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { continuesMessageGroup } from "../../../src/features/messages/message-grouping";
import { MessageRow } from "../../../src/features/messages/MessageRow";
import { MembershipRow } from "../../../src/features/messages/MembershipRow";
import { Button } from "../../../src/shared/design-system/ui/Button";
import { LinkLabel, linkKind } from "../../../src/bundled/links/InlineLink";
import { DiffMessage } from "../../../src/bundled/diffs/DiffMessage";
import { Chart } from "../../../src/bundled/charts/Chart";
import { ChartExpand } from "../../../src/bundled/charts/ChartExpand";
import { MermaidDiagram } from "../../../src/bundled/mermaid/MermaidDiagram";
import { MermaidExpand } from "../../../src/bundled/mermaid/MermaidExpand";
import { parseAccent } from "../../../src/shared/theme/accent";
import referenceStyles from "../../../src/shared/InlineReference.module.css";
import { CustomEmoji } from "../../../src/bundled/emoji/CustomEmoji";
import { emojiMatches } from "../../../src/features/relay/emoji";
import type {
  CodeBlockRenderer,
  ConversationExtensions,
  InlineRenderer,
  LinkRenderer,
  MessageRenderer,
} from "../../../src/features/conversation/contracts";
import type { Contribution } from "../../../src/plugins/contributions";
import { useKeyboardFocusVisibility } from "../../../src/shared/design-system/useKeyboardFocusVisibility";
import {
  agent,
  groups,
  media,
  message,
  profiles,
  reader,
  teammate,
  type Example,
} from "./examples";
import "./styles.css";

// Register production content renderers against fixed local data. No
// plugin manager, relay session, identity, persistence, or app startup runs here.
const inline: readonly Contribution<InlineRenderer>[] = [
  {
    id: "custom",
    key: "gallery/custom",
    pluginId: "gallery",
    revision: "1",
    title: "Custom emoji",
    matches: (content) => [
      ...emojiMatches(
        content.text,
        content.reaction?.emoji
          ? [content.reaction.emoji]
          : (content.message.emoji ?? []),
      ),
    ],
    component: ({ text, content, media }) => {
      const emoji = (
        content.reaction?.emoji
          ? [content.reaction.emoji]
          : (content.message.emoji ?? [])
      ).find((item) => `:${item.shortcode}:` === text.toLowerCase());
      return emoji ? <CustomEmoji emoji={emoji} media={media} /> : text;
    },
  },
];
const links: readonly Contribution<LinkRenderer>[] = [
  {
    id: "links",
    key: "gallery/links",
    pluginId: "gallery",
    revision: "1",
    title: "Links",
    matches: (url) => linkKind(url) !== null,
    className: referenceStyles.link,
    component: ({ url }) => <LinkLabel href={url} />,
  },
];
const messages: readonly Contribution<MessageRenderer>[] = [
  {
    id: "diff",
    key: "gallery/diff",
    pluginId: "gallery",
    revision: "1",
    title: "Code diff",
    matches: (row) => !!row.diff,
    component: DiffMessage,
  },
];
const allCodeBlocks: readonly Contribution<CodeBlockRenderer>[] = [
  {
    id: "mermaid",
    key: "gallery/mermaid",
    pluginId: "gallery",
    revision: "1",
    title: "Mermaid diagram",
    matches: (language) => language.toLowerCase() === "mermaid",
    component: MermaidDiagram,
    action: MermaidExpand,
  },
  {
    id: "buzz-chart",
    key: "gallery/buzz-chart",
    pluginId: "gallery",
    revision: "1",
    title: "Chart",
    matches: (language) => language.toLowerCase() === "buzz-chart",
    component: Chart,
    action: ChartExpand,
  },
];
const codeBlocks =
  new URLSearchParams(location.search).get("charts") === "off"
    ? allCodeBlocks.filter((block) => block.id !== "buzz-chart")
    : allCodeBlocks;
const emptyTools: ReturnType<ConversationExtensions["tools"]["snapshot"]> = [];
const subscribe = () => () => {};
const extensions: ConversationExtensions = {
  inline: { snapshot: () => inline, subscribe },
  links: { snapshot: () => links, subscribe },
  messages: { snapshot: () => messages, subscribe },
  codeBlocks: { snapshot: () => codeBlocks, subscribe },
  tools: { snapshot: () => emptyTools, subscribe },
};
const agentPubkeys = new Set([agent]);

function Specimen({ example }: { example: Example }) {
  const [rows, setRows] = useState(example.rows);
  const [thread, setThread] = useState(false);
  const [action, setAction] = useState("");
  return (
    <section
      className="message-gallery-example"
      aria-labelledby={`label-${example.id}`}
    >
      <header data-buzz-ui="">
        <h3 id={`label-${example.id}`} className="text-label">
          {example.title}
        </h3>
        <p className="text-body-sm text-tertiary">{example.description}</p>
      </header>
      <div className="message-gallery-frame">
        {rows.map((row, index) => {
          const nextRow = rows[index + 1];
          return row.membership ? (
            <MembershipRow
              key={row.id}
              row={row}
              profiles={profiles}
              viewer={reader}
              media={media}
              agentPubkeys={agentPubkeys}
              day={!!example.day && index === 0}
            />
          ) : (
            <MessageRow
              key={row.id}
              row={row}
              viewer={reader}
              stackPrevious={continuesMessageGroup(rows[index - 1], row)}
              stackNext={nextRow ? continuesMessageGroup(row, nextRow) : false}
              profile={profiles.get(row.authorId)}
              participantProfiles={profiles}
              agentPubkeys={agentPubkeys}
              extensions={extensions}
              media={media}
              day={!!example.day && index === 0}
              onOpenLink={(url) => {
                if (
                  row.attachments.some(
                    (attachment) =>
                      attachment.kind === "image" && attachment.url === url,
                  )
                )
                  return false;
                setAction(
                  "Sample link selected. In the app, this opens its destination.",
                );
                return true;
              }}
              canOpenLink={() => true}
              retry={(id) =>
                setRows((current) =>
                  current.map((item) =>
                    item.id === id ? { ...item, delivery: "seen" } : item,
                  ),
                )
              }
              onOpenThread={() => setThread((value) => !value)}
              {...(example.timecode
                ? {
                    onMediaTime: (seconds: number) =>
                      setAction(`Sample playback moved to ${seconds} seconds.`),
                  }
                : {})}
            />
          );
        })}
        {thread && (
          <section
            aria-label="Sample thread replies"
            className="message-gallery-thread"
          >
            <p data-buzz-ui="" className="text-body-sm text-tertiary">
              Sample thread replies
            </p>
            {[
              message("reply-one", "A short explanation would help here.", {
                authorId: teammate,
              }),
              message("reply-two", "I’ll draft an option.", {
                authorId: agent,
                agentEnvelope: true,
              }),
            ].map((row) => (
              <MessageRow
                key={row.id}
                row={row}
                profile={profiles.get(row.authorId)}
                day={false}
                retry={undefined}
                media={media}
                onOpenLink={() => true}
              />
            ))}
            <Button size="sm" variant="ghost" onClick={() => setThread(false)}>
              Close replies
            </Button>
          </section>
        )}
        {action && (
          <p
            data-buzz-ui=""
            role="status"
            className="text-body-sm text-tertiary"
          >
            {action}
          </p>
        )}
      </div>
    </section>
  );
}

function Gallery() {
  useKeyboardFocusVisibility();
  const [group, setGroup] = useState(
    new URLSearchParams(location.search).get("group") ?? "all",
  );
  const [narrow, setNarrow] = useState(false);
  const [revision, setRevision] = useState(0);
  return (
    <div className="message-gallery">
      <div data-buzz-ui="" className="message-gallery-controls">
        <fieldset
          aria-label="Message categories"
          className="message-gallery-options"
        >
          {[{ id: "all", title: "All messages" }, ...groups].map((item) => (
            <Button
              key={item.id}
              size="sm"
              variant={group === item.id ? "prominent" : "ghost"}
              aria-pressed={group === item.id}
              onClick={() => setGroup(item.id)}
            >
              {item.title}
            </Button>
          ))}
        </fieldset>
        <div className="message-gallery-options">
          <Button
            size="sm"
            variant="subtle"
            aria-pressed={narrow}
            onClick={() => setNarrow((value) => !value)}
          >
            Narrow preview
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setRevision((value) => value + 1)}
          >
            Reset examples
          </Button>
        </div>
        <p className="text-body-sm text-tertiary">
          Examples show current behavior, including existing inconsistencies.
          Retry, thread, and link actions use local sample state. Changing theme
          resets examples.
        </p>
      </div>
      <div
        key={revision}
        className="message-gallery-examples"
        data-narrow={narrow || undefined}
      >
        {groups
          .filter((item) => group === "all" || item.id === group)
          .map((item) => (
            <section
              key={item.id}
              aria-labelledby={`group-${item.id}`}
              className="message-gallery-group"
            >
              <header data-buzz-ui="">
                <h2 id={`group-${item.id}`} className="text-heading">
                  {item.title}
                </h2>
                <p className="text-body-sm text-tertiary">{item.description}</p>
              </header>
              {item.examples.map((example) => (
                <Specimen key={example.id} example={example} />
              ))}
            </section>
          ))}
      </div>
      <footer data-buzz-ui="" className="text-body-sm text-tertiary">
        Rendered by MessageRow, MessageMarkdown, MembershipRow, DeliveryNotice,
        the bundled link and diff renderers, and the app’s attachment
        components. Composer, presence, unread tracking, history loading, and
        live plugin behavior are separate surfaces and are not simulated here.
      </footer>
    </div>
  );
}
const theme =
  new URLSearchParams(location.search).get("theme") === "dark"
    ? "dark"
    : "light";
document.documentElement.dataset.colorMode = theme;
document.documentElement.dataset.colorLevel = "touch";
document.documentElement.dataset.accent = parseAccent(
  new URLSearchParams(location.search).get("accent"),
);
const container = document.getElementById("root");
if (!container) throw new Error("Missing message gallery root");
createRoot(container).render(
  <StrictMode>
    <ToastProvider>
      <Gallery />
    </ToastProvider>
  </StrictMode>,
);
