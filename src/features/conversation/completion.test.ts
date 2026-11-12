import { Context } from "@deepseek-ai/cordis";
import { expect, it, vi } from "vitest";
import { completionResult, matchCompletion } from "./completion";
import type {
  CompletionContext,
  CompletionEdit,
  ComposerCompletion,
} from "./contracts";
import { chosenWorkspace, workspaceEdit } from "./workspace-completion";
import type { Contribution } from "../../plugins/contributions";
import type { PluginModule } from "../../plugins/api";
import type { PluginInfo } from "../../plugins/types";
import { PluginRuntime } from "../../plugins/runtime";
import { ConversationService } from "./service";
const observation = { revision: 1, text: "@hi", start: 3, end: 3 };
const context = {} as CompletionContext;
const provider = (
  key: string,
  start: number,
  end: number,
  order = 0,
): Contribution<ComposerCompletion> => ({
  key,
  id: key,
  pluginId: key,
  title: key,
  revision: "one",
  order,
  match: () => ({ start, end, query: "hi" }),
  component: () => null,
});
it("validates and deterministically arbitrates optional provider ranges", () => {
  expect(
    matchCompletion(
      [provider("z", 0, 3), provider("a", 0, 3)],
      observation,
      context,
    )?.provider.id,
  ).toBe("a");
  expect(
    matchCompletion(
      [provider("a", -1, 3), provider("z", 0, 3)],
      observation,
      context,
    )?.provider.id,
  ).toBe("z");
  expect(
    matchCompletion([provider("a", 0, 2)], observation, context),
  ).toBeUndefined();
  expect(
    matchCompletion([provider("a", 0, 3)], { ...observation, end: 4 }, context),
  ).toBeUndefined();
});
it("snapshots valid edit primitives, rejects malformed/duplicate candidates and bounds output", () => {
  const recipient = { pubkey: "a".repeat(64), name: "Honey" };
  const input = {
    items: [
      { id: "one", label: "Honey", edit: { mention: recipient } },
      { id: "one", label: "duplicate", edit: { text: "bad" } },
      {
        id: "two",
        label: "bad key",
        edit: { mention: { name: "X", pubkey: "bad" } },
      },
    ],
  };
  const result = completionResult(input);
  recipient.pubkey = "b".repeat(64);
  expect(result.items).toHaveLength(1);
  expect(result.items[0]?.edit.mention?.pubkey).toBe("a".repeat(64));
  expect(
    completionResult({
      items: Array.from({ length: 100 }, (_, i) => ({
        id: String(i),
        label: String(i),
        edit: { text: "text" },
      })),
    }).items,
  ).toHaveLength(50);
});

it("copies and freezes provider-owned query primitives", () => {
  const query = { start: 0, end: 3, query: "hi" };
  const match = matchCompletion(
    [{ ...provider("a", 0, 3), match: () => query }],
    observation,
    context,
  );
  query.start = 2;
  query.query = "changed";
  expect(match?.query).toEqual({ start: 0, end: 3, query: "hi" });
  expect(Object.isFrozen(match?.query)).toBe(true);
});

it("the closest trigger wins over an earlier broad query, then order resolves ties", () => {
  const editor = { revision: 2, text: "@Honey :smile", start: 13, end: 13 };
  expect(
    matchCompletion(
      [provider("mentions", 0, 13, -10), provider("emoji", 7, 13)],
      editor,
      context,
    )?.provider.id,
  ).toBe("emoji");
});

it("a trigger that starts inside a resolved chip is not an open query; later triggers still are", () => {
  const editor = { revision: 3, text: "@Honey hi :smile", start: 16, end: 16 };
  const chip = [{ start: 0, end: 6 }];
  expect(
    matchCompletion([provider("mentions", 0, 16)], editor, context, chip),
  ).toBeUndefined();
  expect(
    matchCompletion(
      [provider("mentions", 0, 16, -10), provider("emoji", 10, 16)],
      editor,
      context,
      chip,
    )?.provider.id,
  ).toBe("emoji");
  expect(
    matchCompletion([provider("mentions", 10, 16)], editor, context, chip)
      ?.provider.id,
  ).toBe("mentions");
});

it("keeps the agent mark only when a provider sets it to true", () => {
  const mention = { pubkey: "a".repeat(64), name: "Fizz" };
  const result = completionResult({
    items: [
      { id: "agent", label: "Fizz", agent: true, edit: { mention } },
      { id: "person", label: "Fizz", edit: { mention } },
      {
        id: "malformed",
        label: "Fizz",
        agent: "yes" as unknown as boolean,
        edit: { mention },
      },
    ],
  });
  expect(result.items.map((item) => item.agent)).toEqual([
    true,
    undefined,
    undefined,
  ]);
});

it("copies and freezes batch recipients without allowing malformed or oversized edits", () => {
  const carl = { pubkey: "a".repeat(64), name: "Carl" };
  const recipients = [carl, { pubkey: "b".repeat(64), name: "Donut" }];
  const result = completionResult({
    items: [{ id: "team", label: "Team", edit: { mentions: recipients } }],
  });
  carl.name = "Changed";
  recipients.push({ pubkey: "c".repeat(64), name: "Mongo" });
  const saved = result.items[0]?.edit.mentions;
  expect(saved).toEqual([
    { pubkey: "a".repeat(64), name: "Carl" },
    { pubkey: "b".repeat(64), name: "Donut" },
  ]);
  expect(Object.isFrozen(saved)).toBe(true);
  expect(Object.isFrozen(saved?.[0])).toBe(true);
  for (const mentions of [
    [],
    [{ pubkey: "bad", name: "Carl" }],
    [{ pubkey: "a".repeat(64), name: " " }],
    Array.from({ length: 33 }, () => carl),
  ]) {
    expect(
      completionResult({
        items: [{ id: "bad", label: "Bad", edit: { mentions } }],
      }).items,
    ).toEqual([]);
  }
});
it("keeps a host workspace edit and drops a provider's look-alike", () => {
  const host = workspaceEdit("design");
  const result = completionResult({
    items: [
      { id: "host", label: "Design", edit: host },
      {
        id: "plugin",
        label: "Design",
        edit: { workspace: "design" } as unknown as CompletionEdit,
      },
    ],
  });
  expect(result.items.map((item) => item.id)).toEqual(["host"]);
  expect(result.items[0]?.edit).toBe(host);
  expect(chosenWorkspace(host)).toBe("design");
  expect(chosenWorkspace({ text: "#design" })).toBeUndefined();
});

it("keeps chip edits only from a provider a bundled plugin registered, for that registration's lifetime", async () => {
  const folder = {
    kind: "folder" as const,
    id: "/notes",
    label: "@notes",
  };
  const offered = {
    items: [
      { id: "notes", label: "notes", edit: { token: folder } },
      { id: "text", label: "Text", edit: { text: "notes" } },
    ],
  };
  // Everything a provider can say about itself looks like the bundled one.
  const lookalike = (id: string) =>
    ({
      id,
      title: "Mention",
      order: -10,
      pluginId: "buzz.mentions",
      revision: "bundled",
      bundled: true,
      match: () => null,
      component: () => null,
    }) as ComposerCompletion;
  const modules: Record<string, PluginModule> = {
    "buzz.mentions": {
      inject: ["conversation"],
      apply(ctx) {
        ctx.conversation.registerCompletion(lookalike("typeahead"));
      },
    },
    "example.forger": {
      inject: ["conversation"],
      apply(ctx) {
        ctx.conversation.registerCompletion(lookalike("typeahead"));
        // A child scope can claim the bundled id and revision, not its owner.
        const forged = ctx.extend({
          pluginOwner: Object.freeze({
            id: "buzz.mentions",
            revision: "bundled",
            agentHooks: Object.freeze([]),
          }),
        });
        forged.conversation.registerCompletion(lookalike("forged"));
      },
    },
  };
  const info = (id: string, source: PluginInfo["source"]): PluginInfo => ({
    manifest: { id, name: id, apiVersion: 1 },
    enabled: true,
    source,
    revision: source === "bundled" ? "bundled" : "one",
    previous: null,
    reloadable: source !== "bundled",
    error: null,
  });
  const bundled = info("buzz.mentions", "bundled");
  const external = info("example.forger", "external");
  const root = new Context();
  const runtime = new PluginRuntime(root, async (plugin) => {
    const module = modules[plugin.manifest.id];
    if (!module) throw new Error("missing module");
    return module;
  });
  const service = new ConversationService(root);
  const kept = () =>
    Object.fromEntries(
      service.completions
        .snapshot()
        .map((entry) => [
          entry.key,
          completionResult(offered, entry).items.map((item) => item.id),
        ]),
    );
  try {
    runtime.reconcile([bundled, external]);
    await vi.waitFor(() =>
      expect(service.completions.snapshot()).toHaveLength(3),
    );
    const first = service.completions
      .snapshot()
      .find((entry) => entry.key === "buzz.mentions/typeahead");
    expect(kept()).toEqual({
      "buzz.mentions/typeahead": ["notes", "text"],
      "example.forger/typeahead": ["text"],
      "buzz.mentions/forged": ["text"],
    });
    const token = first && completionResult(offered, first).items[0]?.edit;
    expect(token && "token" in token && token.token).toEqual(folder);
    expect(Object.isFrozen(token && "token" in token && token.token)).toBe(
      true,
    );
    // Without a registered entry, a result never carries a chip.
    expect(completionResult(offered).items.map((item) => item.id)).toEqual([
      "text",
    ]);

    runtime.reconcile([external]);
    await vi.waitFor(() =>
      expect(service.completions.snapshot()).toHaveLength(1),
    );
    expect(kept()).toEqual({ "example.forger/typeahead": ["text"] });

    runtime.reconcile([bundled, external]);
    await vi.waitFor(() =>
      expect(service.completions.snapshot()).toHaveLength(3),
    );
    const second = service.completions
      .snapshot()
      .find((entry) => entry.key === "buzz.mentions/typeahead");
    expect(second).not.toBe(first);
    expect(kept()).toEqual({
      "buzz.mentions/typeahead": ["notes", "text"],
      "example.forger/typeahead": ["text"],
      "buzz.mentions/forged": ["text"],
    });
  } finally {
    await runtime.dispose();
    await root.fiber.dispose();
  }
});
