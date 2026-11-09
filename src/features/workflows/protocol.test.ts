import { expect, it } from "vitest";
import {
  hookUrl,
  isWorkflowOperation,
  validateWorkflowEvent,
  parseRuns,
  workflowYaml,
} from "./protocol";
const owner = "a".repeat(64),
  id = "11111111-1111-4111-8111-111111111111",
  runId = "22222222-2222-4222-8222-222222222222";
const yaml =
  "name: Fixture\nenabled: false\ntrigger:\n  on: message_posted\nsteps:\n  - id: 1_send\n    action: send_message\n    text: Hi\n";
const base = {
  id: "b".repeat(64),
  pubkey: owner,
  created_at: 1,
  kind: 30620,
  tags: [
    ["h", id],
    ["d", id],
  ],
  content: yaml,
};
it("strict authoring boundary rejects malformed coordinates/tags, accepts webhook saves and skips generic deletions", () => {
  expect(validateWorkflowEvent(base, owner)).toEqual({
    id,
    owner,
    channelId: id,
  });
  // The relay issues the webhook secret in the receipt; raw YAML saves are ordinary saves.
  expect(
    validateWorkflowEvent(
      { ...base, content: yaml.replace("message_posted", "webhook") },
      owner,
    ),
  ).toEqual({ id, owner, channelId: id });
  expect(hookUrl("https://relay.test", id)).toBe(
    `https://relay.test/hooks/${id}`,
  );
  expect(() => hookUrl("https://relay.test", "name")).toThrow(
    "Invalid workflow ID",
  );
  for (const event of [
    { ...base, pubkey: "c".repeat(64) },
    {
      ...base,
      tags: [
        ["h", "../"],
        ["d", id],
      ],
    },
    { ...base, tags: [...base.tags, ["d", id]] },
    { ...base, tags: [...base.tags, ["client-id", "x"], ["client-id", "y"]] },
    { ...base, tags: [...base.tags, ["expected-revision", "bad"]] },
    { ...base, kind: 46020 },
    { ...base, created_at: Infinity },
  ])
    expect(() => validateWorkflowEvent(event, owner)).toThrow();
  expect(isWorkflowOperation({ kind: 5, tags: [["e", "b".repeat(64)]] })).toBe(
    false,
  );
  expect(
    isWorkflowOperation({ kind: 5, tags: [["a", `30620:${owner}:${id}`]] }),
  ).toBe(true);
  expect(() =>
    validateWorkflowEvent(
      {
        ...base,
        kind: 5,
        content: "",
        tags: [
          ["h", id],
          ["a", `30620:${owner}:${id}`],
        ],
      },
      owner,
    ),
  ).not.toThrow();
});
it("allows human-signed canonical deletes targeting another author without allowing signer impersonation", () => {
  const author = "c".repeat(64);
  const event = {
    ...base,
    kind: 5,
    content: "",
    tags: [
      ["h", id],
      ["a", `30620:${author}:${id}`],
    ],
  };
  expect(validateWorkflowEvent(event, owner)).toEqual({
    id,
    channelId: id,
    owner: author,
  });
  expect(() =>
    validateWorkflowEvent({ ...event, pubkey: author }, owner),
  ).toThrow();
  expect(() =>
    validateWorkflowEvent(
      { ...event, tags: [...event.tags, ["e", base.id]] },
      owner,
    ),
  ).toThrow();
});
it("YAML remains unchanged and malformed input/duplicate steps are rejected", () => {
  expect(workflowYaml(yaml)).toMatchObject({ enabled: false });
  for (const text of [
    "[]",
    yaml.replace("enabled: false", "enabled: null"),
    yaml.replace("enabled: false", 'enabled: "false"'),
    yaml.replace("enabled: false", "enabled: 0"),
    yaml.replace("1_send", "my-step"),
    `${yaml}  - id: 1_send\n    action: delay\n    duration: 1s\n`,
    "x".repeat(24001),
    "name: [bad",
  ]) {
    expect(() => workflowYaml(text)).toThrow();
  }
});
it("legacy omitted enabled and explicit toggles cross the real event boundary unchanged", () => {
  for (const [line, enabled] of [
    ["", true],
    ["enabled: true\n", true],
    ["enabled: false\n", false],
  ] as const) {
    const content = yaml.replace("enabled: false\n", line);
    const event = { ...base, content };
    expect(workflowYaml(content).enabled).toBe(enabled);
    expect(validateWorkflowEvent(event, owner)).toEqual({
      id,
      owner,
      channelId: id,
    });
    expect(event.content).toBe(content);
  }
});
it("run rows require matching identities and preserve exact cursor precision", () => {
  const row = {
    id: runId,
    workflow_id: id,
    status: "completed",
    current_step: 1,
    execution_trace: [],
    started_at: 1,
    completed_at: 2,
    created_at: 1,
    error_code: null,
    error_message: null,
  };
  const before = "2026-09-12T14:44:19.123456+00:00";
  const raw = { runs: [row], next: { before, before_id: runId } };
  expect(parseRuns(raw, id).next).toEqual({ before, beforeId: runId });
  for (const value of [
    { ...raw, runs: [row, row] },
    { ...raw, runs: [{ ...row, workflow_id: runId }] },
    { ...raw, runs: [{ ...row, status: "imaginary" }] },
    { ...raw, next: { before } },
    { ...raw, runs: Array(21).fill(row) },
  ]) {
    expect(() => parseRuns(value, id)).toThrow();
  }
});
