import { expect, it } from "vitest";
import {
  getAgentMentionWarning,
  resolveWorkflowMentions,
  OWNER_RUNS_WARNING,
  STEPS_WARNING,
  WEBHOOK_WARNING,
  workflowAgentMentions,
} from "./workflowAgentMentionWarning";

const definition = (
  trigger: string,
  text = "@Builder review this",
  extra = "",
) => `name: Review
trigger:
  on: ${trigger}
steps:
  - id: say
    action: send_message
    text: "${text}"
${extra}`;
const member = (pubkey: string, name: string, agent = true) => ({
  pubkey,
  name,
  label: name,
  agent,
});
const builder = member("b", "Builder");
const warn = (
  yaml: string,
  mode = workflowAgentMentions({ workflow_agent_mentions: "owner" }),
  members = [builder],
) => getAgentMentionWarning(yaml, members, mode);

it.each(["message_posted", "reaction_added", "diff_posted"])(
  "warns that only your own runs direct agents on a %s trigger",
  (trigger) => expect(warn(definition(trigger))).toBe(OWNER_RUNS_WARNING),
);

const fetchStep = `  - id: fetch
    action: call_webhook
    url: https://example.test
`;

it("warns that agents never respond on a webhook trigger", () => {
  expect(warn(definition("webhook"))).toBe(WEBHOOK_WARNING);
});

it("prefers the webhook warning when a webhook trigger has other steps", () => {
  expect(warn(definition("webhook", undefined, fetchStep))).toBe(
    WEBHOOK_WARNING,
  );
});

it("warns that agents never respond with any step but a message or delay", () => {
  expect(warn(definition("schedule", undefined, fetchStep))).toBe(
    STEPS_WARNING,
  );
});

it("gives a message trigger with other steps the steps warning", () => {
  expect(warn(definition("message_posted", undefined, fetchStep))).toBe(
    STEPS_WARNING,
  );
});

it("doesn't warn a schedule with only message and delay steps", () => {
  const delay = `  - id: wait
    action: delay
    duration: 5m
`;
  expect(warn(definition("schedule", undefined, delay))).toBeNull();
});

it("doesn't warn without an agent mention", () => {
  expect(warn(definition("webhook", "@Someone else"))).toBeNull();
  expect(getAgentMentionWarning(definition("webhook"), [], "owner")).toBeNull();
});

it("doesn't warn on a relay that lets any run direct agents, or an older one", () => {
  expect(warn(definition("webhook"), workflowAgentMentions({}))).toBeNull();
  expect(
    warn(
      definition("webhook"),
      workflowAgentMentions({ workflow_agent_mentions: "any" }),
    ),
  ).toBeNull();
  expect(workflowAgentMentions({ workflow_agent_mentions: "OWNER" })).toBe(
    "any",
  );
});

it.each([
  ["@builder review this", true],
  ["@BUILDER, review this", true],
  ["(@Builder) review", true],
  ["@BuilderExtra review", false],
  ["mail@Builder review", false],
  ["@Builder_2 review", false],
])("matches %s as the relay does", (text, warns) => {
  expect(warn(definition("webhook", text)) !== null).toBe(warns);
});

it("matches the longest name first, then checks it is an agent", () => {
  const person = member("p", "Builder Bob", false);
  expect(
    warn(definition("webhook", "@Builder Bob review"), undefined, [
      builder,
      person,
    ]),
  ).toBeNull();
  expect(
    resolveWorkflowMentions("@Builder Bob and @Builder", [builder, person]),
  ).toEqual([person, builder]);
});

it("names no one for a name two members share", () => {
  const twin = member("t", "builder", false);
  expect(warn(definition("webhook"), undefined, [builder, twin])).toBeNull();
  expect(
    resolveWorkflowMentions("@Builder", [builder, { ...builder }]),
  ).toEqual([builder]);
});

it("folds case per code point, so later mentions keep their place", () => {
  const dotted = member("i", "İ", false);
  expect(resolveWorkflowMentions("@İ @Builder", [dotted, builder])).toEqual([
    dotted,
    builder,
  ]);
});

it("folds names and text as the relay does, Unicode included", () => {
  const sigma = member("s", "ΟΣ");
  expect(resolveWorkflowMentions("@ος", [sigma])).toEqual([sigma]);
  expect(resolveWorkflowMentions("@ΟΣ", [sigma])).toEqual([]);
  for (const mark of ["\u0345", "\u05B0"])
    expect(resolveWorkflowMentions(`@Builder${mark}`, [builder])).toEqual([]);
  expect(resolveWorkflowMentions("\u0085@Builder", [builder])).toEqual([
    builder,
  ]);
  expect(resolveWorkflowMentions("\uFEFF@Builder", [builder])).toEqual([]);
  const blank = member("w", "\u0085");
  expect(resolveWorkflowMentions("@\u0085 @Builder", [blank, builder])).toEqual(
    [builder],
  );
});
