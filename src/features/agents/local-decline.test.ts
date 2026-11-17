import { expect, it } from "vitest";
import { createAgentActivity } from "./activity";
import { createLocalAgentActivity } from "./local-activity";

const scope = "https://relay.test:viewer",
  agent = "a".repeat(64),
  message = "b".repeat(64);
const begin = (local: ReturnType<typeof createLocalAgentActivity>) =>
  local.begin({
    scope,
    agent,
    channelId: "channel",
    messageId: message,
    threadRootId: message,
  });
const project = (local: ReturnType<typeof createLocalAgentActivity>) =>
  createAgentActivity(
    false,
    () => {},
    (channel) => channel === "channel",
    undefined,
    undefined,
    { source: local.reader, scope },
  );

it("keeps why an agent declined a mention, for its owner's view", () => {
  const local = createLocalAgentActivity();
  const activity = project(local);
  try {
    begin(local).remove("workflow");
    expect(activity.queries.snapshot().local).toEqual([]);
    expect(activity.queries.snapshot().declined).toEqual([
      {
        scope,
        agent,
        channelId: "channel",
        messageId: message,
        refusal: "workflow",
      },
    ]);
    // Handling the message again replaces its note.
    begin(local);
    expect(activity.queries.snapshot().declined).toEqual([]);
  } finally {
    activity.dispose();
  }
});

it("shows no note for a rejection without a reason", () => {
  const local = createLocalAgentActivity();
  begin(local).remove();
  expect(local.reader.declined?.()).toEqual([]);
});

it("forgets notes with the agent's activity", () => {
  const local = createLocalAgentActivity();
  begin(local).remove("workflow");
  local.clear(scope, agent);
  expect(local.reader.declined?.()).toEqual([]);
});
