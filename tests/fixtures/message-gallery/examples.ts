import { eventDto } from "../../../src/features/relay/events";
import { foldMessages } from "../../../src/features/relay/fold";
import { keypair, signed } from "../../../src/features/relay/testing";
import type {
  ChannelMessage,
  Profile,
} from "../../../src/features/relay/contracts";
import type { TimelineRow } from "../../../src/features/messages/membership-rows";
import video from "./assets/sample.mp4";
import avatar from "../design-system/assets/avatar.png";
import animatedGif from "../attachment-media/animated.gif";

export const reader = "a".repeat(64);
export const teammate = "b".repeat(64);
export const agent = "c".repeat(64);
const workflowRelay = keypair();
const workflowOwner = keypair();
const missingWorkflowOwner = keypair();
const reviewers = [
  "Jordan Lee",
  "Priya Shah",
  "Chen Wei",
  "Maya Ortiz",
  "Noah Kim",
  "Ines Duarte",
  "Tariq Haddad",
  "Lena Fischer",
  "Omar Farouk",
  "Ruth Okafor",
  "Diego Alvarez",
  "Hana Sato",
].map((name, index) => ({
  name,
  pubkey: "123456789def".charAt(index).repeat(64),
}));
export const profiles = new Map<string, Profile>([
  [workflowOwner.pubkey, { name: "Wes" }],
  [reader, { name: "Alex Morgan", picture: "https://fixture.test/avatar" }],
  [teammate, { name: "Sam Rivera" }],
  [agent, { name: "Studio assistant", isAgent: true }],
  ...reviewers.map(({ name, pubkey }) => [pubkey, { name }] as const),
]);
export const artwork = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#e9e8e4"/><circle cx="460" cy="100" r="48" fill="#cda97c"/><path d="M0 360L180 120L390 360M210 360L425 180L640 360" fill="#859e89"/></svg>')}`;
export const media = (url: string) => {
  if (url.endsWith("/panorama"))
    return `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1"><path d="M0 .5H1000" stroke="#859e89"/></svg>')}`;
  if (url.includes("/gif-")) return animatedGif;
  if (url.endsWith("/video")) return video;
  if (url.endsWith("/avatar")) return avatar;
  if (url.endsWith("/landscape") || url.endsWith("/poster")) return artwork;
  if (url.endsWith("/notes")) return "https://example.com/design-notes.txt";
  if (url.endsWith("/download"))
    return `buzz-media://localhost/${encodeURIComponent(`https://fixture.test/media/${"f".repeat(64)}.txt`)}`;
  return undefined;
};
export function message(
  id: string,
  content: string,
  patch: Partial<ChannelMessage> = {},
): ChannelMessage {
  return {
    id,
    channelId: "studio",
    authorId: reader,
    createdAt: 1_790_078_400,
    content,
    mentions: [],
    attachments: [],
    reactions: [],
    replyCount: 0,
    participants: [],
    ...patch,
  };
}
export type Example = {
  id: string;
  title: string;
  description: string;
  rows: TimelineRow[];
  day?: boolean;
  timecode?: boolean;
};
export type Group = {
  id: string;
  title: string;
  description: string;
  examples: Example[];
};
const single = (
  id: string,
  title: string,
  description: string,
  content: string,
  patch: Partial<ChannelMessage> = {},
): Example => ({ id, title, description, rows: [message(id, content, patch)] });
const references =
  "@Sam Rivera and @Studio assistant — check [the design notes](https://example.com/notes), [PR #42](https://github.com/block/buzz/pull/42), and [#design](buzz://channel/gallery).\n\nRaw service link: https://github.com/block/buzz/issues/42\n\n||The surprise is in the [release notes](https://example.com/release).||";
const patch =
  "diff --git a/greeting.ts b/greeting.ts\n--- a/greeting.ts\n+++ b/greeting.ts\n@@ -1 +1 @@\n-const greeting = 'Hello';\n+const greeting = 'Welcome';\n";
export const groups: Group[] = [
  {
    id: "agent-coordination",
    title: "Agent coordination",
    description:
      "Compact activity rows use author avatars, inline mentions, and expandable text.",
    examples: [
      {
        id: "repeated-agent",
        title: "Consecutive agent updates",
        description:
          "Individual rows keep previews within the message width. Timeline group folding is exercised separately.",
        rows: [
          message(
            "coordination-intro",
            "I’ll investigate the missing icons and check the rendered result.",
            { authorId: agent },
          ),
          message("coordination-first", "Investigating the missing icons.", {
            authorId: agent,
            audience: "agents",
          }),
          message(
            "coordination-next",
            "Found the cause. The activity rows were rendering their own avatars rather than using the conversation’s message grouping. I’m updating the shared grouping and matching the width of these previews to the surrounding messages.\n\nThe fix is ready to try.",
            {
              authorId: agent,
              audience: "agents",
            },
          ),
          message(
            "coordination-addressed",
            "@Sam Rivera please review the fix.",
            {
              authorId: agent,
              audience: "agents",
              mentions: [teammate],
            },
          ),
        ],
      },
    ],
  },
  {
    id: "session-links",
    title: "Session links",
    description:
      "Session cards rendered through the real message UI, with fixed labels and document icons.",
    examples: [
      {
        id: "session-id",
        title: "Unnamed session",
        description:
          "The document icon and Session label stay fixed; unnamed sessions show their short ID.",
        rows: [
          message("session-id", "[Session: 06366cc0](buzz://channel/06366cc0)"),
        ],
      },
      {
        id: "session-name",
        title: "Chosen name",
        description: "A deliberately chosen name replaces the ID.",
        rows: [
          message(
            "session-name",
            "[Session: PR 45 fixes](buzz://channel/06366cc0)",
          ),
        ],
      },
      {
        id: "session-long-name",
        title: "Long name",
        description:
          "Long names truncate and remain available on hover. Try Narrow preview or enlarged text.",
        rows: [
          message(
            "session-long-name",
            "[Session: PR 45 fixes and a very long chosen title for checking the layout at narrow widths](buzz://channel/06366cc0)",
          ),
        ],
      },
      {
        id: "session-caption",
        title: "Session with a caption",
        description:
          "The caption keeps its bubble; the session card sits below it, within the same message.",
        rows: [
          message(
            "session-caption",
            "Please review these changes.\n\n[Session: PR 45 fixes](buzz://channel/06366cc0)",
          ),
        ],
      },
    ],
  },
  {
    id: "references",
    title: "Links and rich content",
    description:
      "Real link and diff renderers, in received and outgoing bubbles.",
    examples: [
      single(
        "references-received",
        "Received links and mentions",
        "Links stay recognizable without hover; mentions use the same text color.",
        references,
        { authorId: teammate, mentions: [teammate, agent] },
      ),
      single(
        "references-own",
        "Your links and mentions",
        "Colored bubbles preserve contrast for links, mentions, and revealed spoilers.",
        references,
        { mentions: [teammate, agent] },
      ),
      single(
        "wrapped-mentions",
        "Wrapped mentions",
        "Mentions that start a line, wrap or follow a line break all meet the prose edge.",
        `Tagging everyone who reviews message styling. Please check the narrow layout before Friday.\n@Studio assistant can collect the notes.\n\n${reviewers.map(({ name }) => `@${name}`).join(" ")}`,
        {
          authorId: teammate,
          mentions: [agent, ...reviewers.map(({ pubkey }) => pubkey)],
        },
      ),
      single(
        "long-links",
        "Long links",
        "Long destinations wrap inside the bubble. Try Narrow preview.",
        "Join https://feedback.communities.buzz.xyz/invite/workshop-testing to help test, and review https://github.com/block/buzz-app/pull/1423 too.",
        { authorId: teammate },
      ),
      single(
        "table-received",
        "Received standalone table",
        "A received table owns its surface even while message actions show.",
        "| Item | State |\n| --- | --- |\n| Review | Ready |",
        { authorId: teammate },
      ),
      single(
        "table-links",
        "Linked table content",
        "A neutral inset surface owns the text and link colors in a colored bubble.",
        "| Resource | Status |\n| --- | --- |\n| [Design notes](https://example.com/notes) | Ready |\n| [PR #42](https://github.com/block/buzz/pull/42) | Reviewing |",
      ),
      single(
        "code-diff",
        "Code diff preview",
        "The production diff card owns its surface without an outer message bubble.",
        patch,
        {
          diff: {
            filePath: "greeting.ts",
            repoUrl: "https://github.com/block/buzz",
            commitSha: "abcdef0",
            description: "Update the greeting",
            truncated: false,
          },
        },
      ),
    ],
  },
  {
    id: "gifs",
    title: "Sent images and GIFs",
    description: "Full-frame image previews, with and without message text.",
    examples: [
      single(
        "gif-only",
        "GIF only",
        "Known dimensions reserve the full frame.",
        "",
        {
          attachments: [
            {
              url: "https://fixture.test/gif-landscape.gif",
              kind: "image",
              dimensions: { width: 480, height: 320 },
            },
          ],
        },
      ),
      single(
        "gif-caption",
        "GIF with text",
        "Missing dimensions retain a stable frame without cropping.",
        "A little celebration!",
        {
          attachments: [
            {
              url: "https://fixture.test/gif-caption.GIF?version=1",
              kind: "image",
            },
          ],
        },
      ),
      single(
        "gif-multiple",
        "Multiple GIFs and a photo",
        "All images keep full previews in attachment order.",
        "Both of these made me smile.",
        {
          attachments: [
            {
              url: "https://fixture.test/gif-one.gif",
              kind: "image",
              dimensions: { width: 480, height: 320 },
            },
            {
              url: "https://fixture.test/landscape",
              kind: "image",
              dimensions: { width: 640, height: 360 },
            },
            {
              url: "https://fixture.test/gif-extensionless",
              kind: "image",
            },
          ],
        },
      ),
      single(
        "gif-unavailable",
        "Unavailable GIF",
        "Unavailable media keeps a readable status.",
        "This GIF is unavailable.",
        {
          attachments: [
            { url: "https://fixture.test/unavailable.gif", kind: "image" },
          ],
        },
      ),
      single(
        "image-panorama",
        "Thin image in a narrow column",
        "The preview target retains at least one CSS pixel when it shrinks.",
        "",
        {
          attachments: [
            {
              url: "https://fixture.test/panorama",
              kind: "image",
              dimensions: { width: 360, height: 1 },
            },
          ],
        },
      ),
      single(
        "emoji-wrapped",
        "Wrapped emoji",
        "Large emoji have enough line space when they wrap.",
        "🎉 :landscape: 🚀 👍🏽 :landscape: 👨‍👩‍👧‍👦 🇦🇺 :landscape: 1️⃣ 🎉 :landscape: 🚀 👍🏽 :landscape: 👨‍👩‍👧‍👦 🇦🇺 :landscape: 1️⃣",
        {
          emoji: [
            { shortcode: "landscape", url: "https://fixture.test/landscape" },
          ],
        },
      ),
    ],
  },
  {
    id: "workflow",
    title: "Workflow attribution",
    description:
      "Local signed examples using the real message fold and renderer. No relay connection or workflow execution.",
    examples: [
      {
        id: "workflow-owner",
        title: "Automated message",
        description:
          "Automation leads; owner navigation is labelled. Rest on or open the information icon to read that the owner didn’t send it personally.",
        rows: foldMessages(
          "studio",
          workflowRelay.pubkey,
          [
            eventDto(
              signed(workflowRelay, {
                kind: 9,
                created_at: 1_790_078_400,
                content: "Scheduled check-in: what needs attention today?",
                tags: [
                  ["p", workflowOwner.pubkey],
                  ["h", "studio"],
                  ["buzz:workflow", "true"],
                  ["buzz:workflow-owner", workflowOwner.pubkey],
                ],
              }),
            ),
          ],
          { signingAuthority: workflowRelay.pubkey },
        ),
      },
      {
        id: "workflow-missing-profile",
        title: "Owner profile unavailable",
        description:
          "Ownership remains explicit without guessing a name or borrowing the relay’s profile.",
        rows: foldMessages(
          "studio",
          workflowRelay.pubkey,
          [
            eventDto(
              signed(workflowRelay, {
                kind: 9,
                created_at: 1_790_078_460,
                content: "The weekly summary is ready.",
                tags: [
                  ["p", missingWorkflowOwner.pubkey],
                  ["h", "studio"],
                  ["buzz:workflow", "true"],
                  ["buzz:workflow-owner", missingWorkflowOwner.pubkey],
                ],
              }),
            ),
          ],
          { signingAuthority: workflowRelay.pubkey },
        ),
      },
      single(
        "human-comparison",
        "Human message, unchanged",
        "Human authors keep their own avatar and name.",
        "I’ll review it this afternoon.",
      ),
    ],
  },
  {
    id: "content",
    title: "Content and identity",
    description:
      "Human and agent messages use the same row layout, with different identity shapes.",
    examples: [
      single(
        "text",
        "Plain text",
        "A human author, timestamp, and short message.",
        "The latest designs are ready. Let me know what you think.",
      ),
      single(
        "agent",
        "Agent response",
        "An agent envelope uses a squircle avatar and the same Markdown renderer.",
        "I reviewed the changes. **Two details** still need attention:\n\n- Align the labels.\n- Check the narrow layout.",
        { authorId: agent, agentEnvelope: true },
      ),
      {
        id: "edited",
        title: "Edited messages",
        description:
          "An author's edit is marked after the last line, or below a closing block.",
        rows: [
          message("edited-own", "Hi how are ya.", { edited: true }),
          message("edited-own-emoji", "🎉", { edited: true }),
          message(
            "edited-own-table",
            "| Day | Room |\n| --- | --- |\n| Thu | 4B |",
            {
              edited: true,
            },
          ),
          message("edited-teammate", "Moved the review to Thursday.", {
            authorId: teammate,
            edited: true,
          }),
          message(
            "edited-block",
            "Use this command instead:\n\n```sh\njust iterate\n```",
            { authorId: teammate, edited: true },
          ),
          message("edited-attachment", "", {
            authorId: teammate,
            edited: true,
            attachments: [
              {
                url: "https://fixture.test/landscape",
                kind: "image",
                dimensions: { width: 640, height: 360 },
              },
            ],
          }),
        ],
      },
      single(
        "fallback",
        "Unknown author",
        "Missing profile data falls back to a shortened public key and initials.",
        "I’ll take a look this afternoon.",
        { authorId: "d".repeat(64) },
      ),
      single(
        "long",
        "Long message",
        "Multiple paragraphs and long tokens wrap within the message column.",
        "A longer update helps us inspect line length and vertical rhythm. The same row should remain readable when the panel becomes narrow.\n\nPlease check the spacing around the author, the timestamp, and the body before we move on.\n\n" +
          "long-unbroken-reference-".repeat(8),
      ),
      single(
        "wrapping-short-last-line",
        "Short last line",
        "The bubble and its prose share a compact width without forced line balancing.",
        "im glad shes going to deepmind. one of the places that im curious about going next",
      ),
      single(
        "wrapping-two-sentences",
        "Two conversational sentences",
        "Short paragraphs wrap naturally inside a compact bubble.",
        "man i got my new mac mini yesterday. old one i bought was base level with very little storage space",
      ),
      single(
        "wrapping",
        "Conversational wrapping",
        "Long prose wraps within the compact message measure while retaining pretty wrapping.",
        "and no one seems to have complained about the max character length on messages that results in the right half of the screen being unused",
      ),
      single(
        "markdown",
        "Rich text",
        "Headings, emphasis, quotes, lists, links, and inline code.",
        "### Review notes\n**Ready to review**, with *a few questions* and ~~one resolved item~~.\n\n> Keep the conversation easy to read.\n\n1. Check the default state.\n2. Review the error state.\n\n- [x] Layout\n- [ ] Keyboard behavior\n\nUse `message.id` in the [reference](https://example.com).",
      ),
      single(
        "code",
        "Code and tables",
        "Wide code and tables retain their own scrolling area.",
        "```ts\nconst message = { author: 'Studio assistant', status: 'ready', content: 'A long example for checking horizontal overflow in a narrow panel' };\n```\n\n| State | Meaning | Action |\n| --- | --- | --- |\n| Sent | Confirmed in history | None |\n| Failed | Publication rejected | Retry |",
      ),
      single(
        "emoji",
        "Emoji only",
        "Emoji-only content uses the current enlarged presentation.",
        "🎉 🚀",
      ),
      single(
        "custom-emoji",
        "Custom emoji",
        "An event-local emoji mapping uses the production CustomEmoji renderer.",
        "A little :landscape: inspiration.",
        {
          emoji: [
            { shortcode: "landscape", url: "https://fixture.test/landscape" },
          ],
        },
      ),
      single(
        "custom-emoji-missing",
        "Unavailable custom emoji",
        "The shortcode remains readable when the image cannot resolve.",
        "Thanks :missing:!",
        {
          emoji: [
            { shortcode: "missing", url: "https://fixture.test/missing-emoji" },
          ],
        },
      ),
      single(
        "custom-emoji-only-missing",
        "Unavailable emoji-only message",
        "A transparent message keeps its shortcode readable with colored bubble preferences.",
        ":missing:",
        {
          emoji: [
            { shortcode: "missing", url: "https://fixture.test/missing-emoji" },
          ],
        },
      ),
      single(
        "mentions",
        "Person mention",
        "An explicit recipient plus a matching profile binds the name to its identity.",
        "@Sam Rivera could you review the spacing?",
        { mentions: [teammate] },
      ),
    ],
  },
  {
    id: "diagrams",
    title: "Mermaid diagrams",
    description:
      "Fenced mermaid blocks drawn by the bundled plugin inside the host code frame.",
    examples: [
      single(
        "diagram-flowchart",
        "Flowchart with a subgraph",
        "Nodes, edges and a subgraph between surrounding prose.",
        "Here is the release flow:\n\n```mermaid\nflowchart LR\n  draft[Draft PR] --> review{Review}\n  review -->|changes| draft\n  review -->|approved| ci\n  subgraph Checks\n    ci[CI] --> e2e[Browser tests]\n  end\n  e2e --> merge((Merge))\n```\n\nPing me if a step is unclear.",
        { authorId: agent },
      ),
      single(
        "diagram-sequence",
        "Sequence diagram",
        "Participants, messages and a note.",
        "```mermaid\nsequenceDiagram\n  participant App\n  participant Relay\n  App->>Relay: Publish event\n  Relay-->>App: OK\n  Note over App,Relay: Signed and verified\n```",
        { authorId: agent },
      ),
      single(
        "diagram-pie",
        "Pie chart",
        "Series colors on the message surface.",
        '```mermaid\npie title Review time\n  "Waiting" : 45\n  "Reviewing" : 30\n  "Fixing" : 15\n  "Merging" : 10\n```',
        { authorId: agent },
      ),
      single(
        "diagram-invalid",
        "Invalid source",
        "The parse error and the source replace the diagram.",
        "```mermaid\nflowchart LR\n  A --> (\n```",
        { authorId: agent },
      ),
    ],
  },
  {
    id: "conversation",
    title: "Conversation context",
    description: "Date separators, reactions, thread summaries, and replies.",
    examples: [
      {
        id: "day",
        title: "Date separator and consecutive messages",
        description:
          "The same row composition is used for successive messages, including repeated authors.",
        day: true,
        rows: [
          message("day-a", "Good morning!"),
          message("day-b", "I’ve posted the update above.", {
            createdAt: 1_790_078_460,
          }),
        ],
      },
      single(
        "reactions",
        "Reactions",
        "Reaction tokens below the body, as currently rendered.",
        "This is ready to ship.",
        {
          reactions: ["🎉", "👍", "❤️"].map((content, index) => ({
            content,
            events: [{ id: `sample-reaction-${index}`, authorId: teammate }],
          })),
        },
      ),
      single(
        "thread",
        "Thread summary",
        "Reply count and participant avatars; click to reveal sample replies.",
        "Let’s discuss the empty state here.",
        {
          replyCount: 4,
          participants: [reader, teammate, agent, "e".repeat(64)],
        },
      ),
      single(
        "sent-from-thread",
        "Sent from thread",
        "Thread attribution aligns with the sender above the message bubble.",
        "Bringing this update back to the channel.",
        {
          sentFromThread: {
            rootId: "thread",
            excerpt: "Let’s discuss the empty state here.",
          },
        },
      ),
      single(
        "reply",
        "Thread reply",
        "A reply uses the same row, within its thread context.",
        "The shorter label reads much better.",
        { authorId: teammate, threadRootId: "thread" },
      ),
      {
        ...single(
          "timecode",
          "Media-time reply",
          "A video timestamp anchors feedback to a moment in the clip.",
          "⏱ 0:12 — This transition needs a little more time.",
        ),
        timecode: true,
      },
    ],
  },
  {
    id: "attachments",
    title: "Attachments",
    description:
      "This first gallery pass covers images, video, and files. Audio and voice-note specimens are a follow-up.",
    examples: [
      single(
        "image",
        "Image attachment",
        "A local illustration renders through the real attachment component.",
        "Here’s the first direction.",
        {
          attachments: [
            {
              url: "https://fixture.test/landscape",
              kind: "image",
              dimensions: { width: 640, height: 360 },
            },
          ],
        },
      ),
      single(
        "image-long-caption",
        "Image with a long message",
        "The background hugs the capped text, with the attached image directly below.",
        "I’m sharing a longer update alongside this image so we can check how the message reads in a wide conversation. The text should wrap at a comfortable measure, and the bubble should stop just beyond that text instead of stretching across the entire window. A small attachment underneath should not change the width of the background.\n\nDoes this direction work for the next review?",
        {
          attachments: [
            {
              url: "https://fixture.test/landscape",
              kind: "image",
              dimensions: { width: 640, height: 360 },
            },
          ],
        },
      ),
      single(
        "images",
        "Multiple images",
        "Each image follows the current stacked attachment layout.",
        "Comparing two options.",
        {
          attachments: [
            {
              url: "https://fixture.test/landscape",
              kind: "image",
              dimensions: { width: 640, height: 360 },
            },
            {
              url: "https://fixture.test/poster",
              kind: "image",
              dimensions: { width: 640, height: 360 },
            },
          ],
        },
      ),
      single(
        "image-unavailable",
        "Unavailable image",
        "No media source is available.",
        "The original image can’t be loaded.",
        {
          attachments: [{ url: "https://fixture.test/missing", kind: "image" }],
        },
      ),
      single(
        "video",
        "Video attachment",
        "The clip uses a locally generated sample and the real play/fullscreen controls.",
        "",
        {
          attachments: [
            {
              url: "https://fixture.test/video",
              kind: "video",
              previewUrl: "https://fixture.test/poster",
              dimensions: { width: 640, height: 360 },
            },
          ],
        },
      ),
      single(
        "video-portrait",
        "Portrait video geometry",
        "Portrait metadata keeps a readable preview width without a height clamp.",
        "",
        {
          attachments: [
            {
              url: "https://fixture.test/video",
              kind: "video",
              previewUrl: "https://fixture.test/poster",
              dimensions: { width: 360, height: 640 },
            },
          ],
        },
      ),
      single(
        "video-extreme",
        "Extreme video metadata",
        "An extreme aspect ratio keeps the preview and controls bounded.",
        "",
        {
          attachments: [
            {
              url: "https://fixture.test/video",
              kind: "video",
              previewUrl: "https://fixture.test/poster",
              dimensions: { width: 1, height: 1000000 },
            },
          ],
        },
      ),
      single(
        "video-unavailable",
        "Unavailable video",
        "The same row when video media cannot be resolved.",
        "The recording is unavailable.",
        {
          attachments: [
            { url: "https://fixture.test/missing-video", kind: "video" },
          ],
        },
      ),
      single(
        "file",
        "File attachment",
        "Filename and sender-provided size with an open action.",
        "Notes from our review.",
        {
          attachments: [
            {
              url: "https://fixture.test/notes",
              kind: "file",
              name: "design-review-notes.txt",
              mime: "text/plain",
              size: 12800,
            },
          ],
        },
      ),
      single(
        "file-download",
        "Downloadable file",
        "The native download button uses the same file-card treatment.",
        "A copy of the review notes.",
        {
          attachments: [
            {
              url: "https://fixture.test/download",
              kind: "file",
              name: "review-notes.txt",
              size: 12800,
            },
          ],
        },
      ),
      single(
        "file-unavailable",
        "Unavailable file",
        "Filename remains visible when the source is missing.",
        "The attachment needs to be uploaded again.",
        {
          attachments: [
            {
              url: "https://fixture.test/missing-file",
              kind: "file",
              name: "design-review.pdf",
              mime: "application/pdf",
            },
          ],
        },
      ),
    ],
  },
  {
    id: "delivery",
    title: "Delivery states",
    description:
      "Feedback appears after the existing 10-second grace period. Accepted is not the same as confirmed in history; several pending states intentionally share the same copy.",
    examples: [
      ...(["sending", "accepted", "unknown", "failed", "seen"] as const).map(
        (delivery) =>
          single(
            `delivery-${delivery}`,
            delivery === "seen"
              ? "Confirmed in history"
              : delivery.charAt(0).toUpperCase() + delivery.slice(1),
            delivery === "seen"
              ? "Confirmed messages have no delivery notice."
              : delivery === "failed" || delivery === "unknown"
                ? "Retry is available. The demo retries locally and resets with the gallery."
                : "Shown after the grace period with confirmation still outstanding.",
            "I’ve sent the updated mockups.",
            { delivery },
          ),
      ),
      single(
        "delivery-detail",
        "Unconfirmed with details",
        "Additional delivery context appears beside the retry action.",
        "Please review when you have a moment.",
        {
          delivery: "unknown",
          deliveryError:
            "Connection interrupted. Reconnect to confirm delivery.",
        },
      ),
    ],
  },
  {
    id: "activity",
    title: "Membership activity",
    description:
      "System activity has a quieter layout than conversational messages.",
    examples: [
      ...(["member_joined", "member_left", "member_removed"] as const).map(
        (type) =>
          single(
            type,
            type === "member_joined"
              ? "Member joined"
              : type === "member_left"
                ? "Member left"
                : "Member removed",
            "Rendered by MembershipRow, not a regular message bubble.",
            "",
            {
              membership: {
                type,
                actor: type === "member_removed" ? reader : teammate,
                target: teammate,
              },
            },
          ),
      ),
      {
        id: "grouped-members",
        title: "Grouped joins",
        description:
          "Adjacent membership activity collapses into a single row with multiple identities.",
        rows: [
          {
            ...message("grouped", "", {
              membership: {
                type: "member_joined",
                actor: reader,
                target: reader,
              },
            }),
            membershipRows: [reader, teammate, agent].map((id, index) =>
              message(`join-${index}`, "", {
                membership: { type: "member_joined", actor: id, target: id },
              }),
            ),
          },
        ],
      },
      {
        id: "grouped-members-overflow",
        title: "Grouped joins with overflow",
        description:
          "Beyond three identities the avatar stack ends in a count that must stay legible at two or three digits.",
        rows: [
          {
            ...message("grouped-overflow", "", {
              membership: {
                type: "member_joined",
                actor: reader,
                target: reader,
              },
            }),
            membershipRows: [
              reader,
              teammate,
              agent,
              ...Array.from({ length: 31 }, (_, index) =>
                index.toString(16).padStart(2, "0").repeat(32),
              ),
            ].map((id, index) =>
              message(`join-overflow-${index}`, "", {
                membership: { type: "member_joined", actor: id, target: id },
              }),
            ),
          },
        ],
      },
    ],
  },
];
