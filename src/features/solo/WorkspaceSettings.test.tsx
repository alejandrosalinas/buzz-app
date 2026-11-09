// @vitest-environment jsdom
import { createChannelDetails } from "../relay/channel-details";
import { SOLO_LABEL } from "./labels";
import { PublishRejected } from "../relay/outbox";
import { readView } from "../../shared/view-state";
import { createChannelKit } from "../channel-templates/capability";
import {
  LIVE_CANVAS_BYTES,
  LIVE_CANVAS_LIMIT,
} from "../channel-templates/model";
import type { EventTemplate } from "nostr-tools";
import { keypair, signed } from "../relay/testing";
import { matchesEvent } from "../relay/projection";
import type { RelayEvent } from "../relay/events";
import type { Outbox } from "../relay/outbox";
import "@testing-library/jest-dom/vitest";
import { webcrypto } from "node:crypto";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RelaySession } from "../relay/session";
import { WorkspaceSettings } from "./WorkspaceSettings";
import { readWorkspace, projectTemplateId, workspaceCanvas } from "./workspace";

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("crypto", webcrypto);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("edits a chat's workspace and Canvas with its exact loaded revision", async () => {
  const save = vi.fn(
    async (_channel: string, _content: string, _revision?: string) => ({
      id: "revision-two",
      content: _content,
    }),
  );
  const close = vi.fn();
  const session = {
    canvas: {
      available: true,
      read: async () => ({
        id: "revision-one",
        content: workspaceCanvas({
          folders: ["/repo"],
          canvas: "Keep this context",
        }),
      }),
      save,
    },
  } as unknown as RelaySession;
  render(
    <WorkspaceSettings
      session={session}
      scope="test"
      target={{ kind: "chat", id: "chat", name: "Plan" }}
      close={close}
    />,
  );
  // Without a native picker, folders are added by path.
  expect(
    await screen.findByRole("button", { name: "Remove repo" }),
  ).toBeInTheDocument();
  fireEvent.change(screen.getByRole("textbox", { name: /^Folders/ }), {
    target: { value: "/other" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  fireEvent.click(
    screen.getByRole("switch", { name: "Work in a new worktree" }),
  );
  // One folder list serves both modes.
  expect(screen.getByRole("button", { name: "Remove repo" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Remove other" })).toBeVisible();
  fireEvent.change(screen.getByRole("textbox", { name: "Base branch" }), {
    target: { value: "develop" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(close).toHaveBeenCalled());
  expect(save).toHaveBeenCalledWith(
    "chat",
    expect.stringContaining("origin/develop"),
    "revision-one",
  );
  expect(
    readWorkspace(save.mock.calls[0]?.[1] as unknown as string).canvas,
  ).toBe("Keep this context");
});

it("retains a conflicted draft and never silently reloads over it", async () => {
  const save = vi.fn(async () => {
    throw new Error("Canvas changed elsewhere");
  });
  const close = vi.fn();
  const session = {
    canvas: {
      available: true,
      read: async () => ({ id: "old", content: "Original" }),
      save,
    },
  } as unknown as RelaySession;
  const view = () => (
    <WorkspaceSettings
      session={session}
      scope="test"
      target={{ kind: "chat", id: "chat", name: "Plan" }}
      close={close}
    />
  );
  const mounted = render(view());
  fireEvent.change(
    await screen.findByRole("textbox", { name: /^Instructions/ }),
    {
      target: { value: "My draft" },
    },
  );
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Canvas changed elsewhere",
  );
  expect(close).not.toHaveBeenCalled();
  expect(screen.getByRole("textbox", { name: /^Instructions/ })).toHaveValue(
    "My draft",
  );
  mounted.unmount();
  render(view());
  expect(
    await screen.findByRole("textbox", { name: /^Instructions/ }),
  ).toHaveValue("My draft");
});

it("saves section defaults as an existing relay template without writing section placement", async () => {
  const save = vi.fn(async () => {});
  const close = vi.fn();
  const session = {
    scope: "https://relay.example.test:viewer",
    channelKit: {
      refresh: async () => {},
      snapshot: () => ({ status: "ready", entries: [] }),
      save,
    },
  } as unknown as RelaySession;
  render(
    <WorkspaceSettings
      session={session}
      scope="test"
      target={{ kind: "project", id: "work", name: "Work" }}
      close={close}
    />,
  );
  fireEvent.change(await screen.findByRole("textbox", { name: /^Folders/ }), {
    target: { value: "~/Development/project" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  fireEvent.change(screen.getByRole("textbox", { name: /^Instructions/ }), {
    target: { value: "Work carefully" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save defaults" }));
  await waitFor(() => expect(close).toHaveBeenCalled());
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "template",
      id: await projectTemplateId("work"),
      canvas: expect.stringContaining("Work carefully"),
    }),
    undefined,
  );
});

it("recreates deleted section defaults using the tombstone revision", async () => {
  const viewer = keypair();
  const events: RelayEvent[] = [];
  let time = 1_700_000_000;
  const send = vi.fn((value: Parameters<Outbox["send"]>[0]) => {
    const event = signed(viewer, { ...value, created_at: time++ });
    events.push(event);
    return event.id;
  });
  const kit = createChannelKit({
    viewer: viewer.pubkey,
    community: "https://relay.example.test",
    signal: new AbortController().signal,
    ready: Promise.resolve(),
    canWrite: () => true,
    delivered: async () => {},
    local: undefined,
    outbox: { send, supports: () => true } as unknown as Outbox,
    reader: {
      read: async (filters) =>
        events.filter((event) =>
          filters.some((filter) => matchesEvent(event, filter)),
        ),
    },
    host: {
      prepare: async (record) => JSON.stringify(record),
      decode: async (rows) =>
        rows.map((event) => ({
          eventId: event.id,
          record: JSON.parse(event.content),
        })),
    },
  });
  const session = {
    scope: "https://relay.example.test:viewer",
    channelKit: kit.capability,
  } as unknown as RelaySession;
  const close = vi.fn();
  const view = () => (
    <WorkspaceSettings
      session={session}
      scope="test"
      target={{ kind: "project", id: "work", name: "Work" }}
      close={close}
    />
  );
  const first = render(view());
  fireEvent.change(
    await screen.findByRole("textbox", { name: /^Instructions/ }),
    {
      target: { value: "Old instructions" },
    },
  );
  fireEvent.click(screen.getByRole("button", { name: "Save defaults" }));
  await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  first.unmount();
  const saved = kit.capability.snapshot().entries[0];
  if (!saved) throw new Error("Expected saved section defaults");
  // TemplateLibrary deletes through the same revision-checked save operation.
  await kit.capability.save(saved.record.value, saved.eventId, true);
  expect(kit.capability.snapshot().entries[0]?.record.deleted).toBe(true);
  render(view());
  expect(
    await screen.findByRole("textbox", { name: /^Instructions/ }),
  ).toHaveValue("");
  fireEvent.change(screen.getByRole("textbox", { name: /^Instructions/ }), {
    target: { value: "New instructions" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save defaults" }));
  await waitFor(() => expect(close).toHaveBeenCalledTimes(2));
  const restored = kit.capability.snapshot().entries[0];
  expect(restored?.record.deleted).toBe(false);
  expect(restored?.record.value).toMatchObject({ canvas: "New instructions" });
  expect(send).toHaveBeenCalledTimes(3);
});

// The combined modal talks to the real signed details owner; Canvas remains its
// independent revision/receipt boundary, held explicitly for orchestration tests.
function combined() {
  const id = "11111111-1111-4111-8111-111111111111";
  const viewer = keypair(),
    relay = keypair();
  let ttl: number | undefined = 600,
    clock = 100,
    description = "",
    name = "Plan";
  let labels: string[][] = [["t", SOLO_LABEL]];
  const record = (kind: number, tags: string[][]) =>
    signed(relay, {
      kind,
      tags: [["d", id], ...tags],
      content: "",
      created_at: clock,
    });
  const read = vi.fn(async () => [
    record(39000, [
      ["name", name],
      ["about", description],
      ["t", "stream"],
      ...labels,
      ["private"],
      ...(ttl === undefined ? [] : [["ttl", String(ttl)]]),
    ]),
    record(39001, [["p", viewer.pubkey, "owner"]]),
    record(39002, [["p", viewer.pubkey, "", "owner"]]),
  ]);
  const sign = vi.fn(async (template: EventTemplate) =>
    signed(viewer, template),
  );
  const apply = (event: EventTemplate) => {
    name = event.tags.find(([key]) => key === "name")?.[1] ?? name;
    description =
      event.tags.find(([key]) => key === "about")?.[1] ?? description;
    const duration = event.tags.find(([key]) => key === "ttl");
    if (duration) ttl = duration[1] === "" ? undefined : Number(duration[1]);
    if (event.tags.some(([key]) => key === "t"))
      labels = event.tags.filter(([key]) => key === "t");
    clock++;
  };
  const publish = vi.fn(async (event: EventTemplate) => apply(event));
  const details = createChannelDetails({
    labels: true,
    reader: { read },
    writer: { sign, publish },
    viewer: viewer.pubkey,
    relayAuthor: relay.pubkey,
    canAccess: () => true,
    acceptDiscovery: () => {},
  });
  let head = { id: "revision-one", content: "Original Canvas" };
  const canvas = {
    available: true,
    read: vi.fn(async () => head),
    save: vi.fn(async (_id: string, content: string, _base?: string) => {
      head = { id: "revision-two", content };
      return head;
    }),
  };
  const close = vi.fn(),
    visit = new AbortController();
  const session = {
    canvas,
    channelDetails: details.capability,
  } as unknown as RelaySession;
  const view = () => (
    <WorkspaceSettings
      session={session}
      scope="test"
      target={{ kind: "chat", id, name: "Plan" }}
      signal={visit.signal}
      close={close}
    />
  );
  const mounted = render(view());
  return {
    id,
    session,
    canvas,
    read,
    sign,
    publish,
    details,
    close,
    visit,
    mounted,
    view,
    apply,
    rename: (next: string) => {
      name = next;
      clock++;
    },
    saved: (next: number | undefined) => {
      ttl = next;
      clock++;
    },
    convert: () => {
      labels = [];
      clock++;
    },
  };
}
async function editBoth() {
  const field = await screen.findByRole("textbox", {
    name: /^Instructions/,
  });
  await waitFor(() =>
    expect(
      screen.getByRole("radio", { name: /^Temporary/ }),
    ).not.toHaveAttribute("aria-disabled", "true"),
  );
  fireEvent.change(field, { target: { value: "Draft Canvas" } });
  fireEvent.click(screen.getByRole("radio", { name: /^Ongoing/ }));
}
const saveChanges = () => screen.getByRole("button", { name: "Save changes" });
const draftKey = (id: string) => `solo:workspace-draft:chat:${id}`;

it("confirms Canvas first, retains both drafts on lifetime refusal, and retries only lifetime", async () => {
  const h = combined();
  h.publish.mockRejectedValueOnce(new PublishRejected("Lifetime refused"));
  await editBoth();
  fireEvent.click(saveChanges());
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Workspace and Canvas saved. Lifetime refused",
  );
  expect(h.close).not.toHaveBeenCalled();
  expect(screen.getByRole("textbox", { name: /^Instructions/ })).toHaveValue(
    "Draft Canvas",
  );
  expect(screen.getByRole("radio", { name: /^Ongoing/ })).toBeChecked();
  expect(readView("test", draftKey(h.id), null)).toMatchObject({
    canvas: "Draft Canvas",
    base: "revision-two",
  });
  expect(h.canvas.save.mock.invocationCallOrder[0]).toBeLessThan(
    h.sign.mock.invocationCallOrder[0] ?? 0,
  );
  fireEvent.click(saveChanges());
  await waitFor(() => expect(h.close).toHaveBeenCalledOnce());
  expect(h.canvas.save).toHaveBeenCalledOnce();
  expect(h.publish).toHaveBeenCalledTimes(2);
  expect(readView("test", draftKey(h.id), null)).toBeNull();
});

it("Canvas refusal stops lifetime, and reload preserves the independent lifetime choice", async () => {
  const h = combined();
  h.canvas.save.mockRejectedValueOnce(new Error("Canvas changed elsewhere"));
  await editBoth();
  fireEvent.click(saveChanges());
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Canvas changed elsewhere",
  );
  expect(h.sign).not.toHaveBeenCalled();
  expect(screen.getByRole("textbox", { name: /^Instructions/ })).toHaveValue(
    "Draft Canvas",
  );
  expect(screen.getByRole("radio", { name: /^Ongoing/ })).toBeChecked();
  fireEvent.click(
    screen.getByRole("button", { name: "Review saved settings" }),
  );
  fireEvent.click(
    screen.getByRole("button", {
      name: "Discard draft and reload saved settings",
    }),
  );
  await waitFor(() =>
    expect(screen.getByRole("textbox", { name: /^Instructions/ })).toHaveValue(
      "Original Canvas",
    ),
  );
  expect(screen.getByRole("radio", { name: /^Ongoing/ })).toBeChecked();
  fireEvent.click(saveChanges());
  await waitFor(() => expect(h.close).toHaveBeenCalledOnce());
  expect(h.canvas.save).toHaveBeenCalledOnce();
  expect(h.publish).toHaveBeenCalledOnce();
});

it("remount checks uncertain lifetime without replaying confirmed Canvas; remaining Canvas waits for Save changes", async () => {
  const h = combined();
  h.publish.mockRejectedValueOnce(new Error("Lost ack"));
  await editBoth();
  fireEvent.click(saveChanges());
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "may have been saved",
  );
  h.mounted.unmount();
  render(h.view());
  const check = await screen.findByRole("button", {
    name: "Check save status",
  });
  await waitFor(() => expect(check).toBeEnabled());
  expect(screen.getByRole("textbox", { name: /^Instructions/ })).toHaveValue(
    "Draft Canvas",
  );
  fireEvent.change(screen.getByRole("textbox", { name: /^Instructions/ }), {
    target: { value: "Next Canvas" },
  });
  h.saved(undefined);
  fireEvent.click(check);
  await waitFor(() => expect(saveChanges()).toBeEnabled());
  expect(screen.getByRole("status")).toHaveTextContent(
    "Chat name and lifetime saved. Workspace and Canvas still have unsaved changes.",
  );
  expect(h.close).not.toHaveBeenCalled();
  expect(h.canvas.save).toHaveBeenCalledOnce();
  expect(h.sign).toHaveBeenCalledOnce();
  // A new lifetime edit after successful check must reload its real version.
  fireEvent.click(screen.getByRole("radio", { name: /^Temporary/ }));
  h.publish.mockImplementationOnce(async () => h.saved(604800));
  fireEvent.click(saveChanges());
  await waitFor(() => expect(h.close).toHaveBeenCalledOnce());
  expect(h.canvas.save).toHaveBeenLastCalledWith(
    h.id,
    "Next Canvas",
    "revision-two",
  );
  expect(h.publish).toHaveBeenCalledTimes(2);
});

it("rechecks Solo eligibility after recovery before saving another lifetime edit", async () => {
  const h = combined();
  h.publish.mockRejectedValueOnce(new Error("Lost ack"));
  await editBoth();
  fireEvent.click(saveChanges());
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "may have been saved",
  );
  fireEvent.change(screen.getByRole("textbox", { name: /^Instructions/ }), {
    target: { value: "Next Canvas" },
  });
  h.saved(undefined);
  fireEvent.click(screen.getByRole("button", { name: "Check save status" }));
  await waitFor(() => expect(saveChanges()).toBeEnabled());
  expect(h.close).not.toHaveBeenCalled();
  h.convert();
  h.publish.mockImplementationOnce(async () => h.saved(604800));
  fireEvent.click(screen.getByRole("radio", { name: /^Temporary/ }));
  fireEvent.click(saveChanges());
  await waitFor(() => expect(h.canvas.save).toHaveBeenCalledTimes(2));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled(),
  );
  expect(h.sign).toHaveBeenCalledOnce();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "no longer an editable Solo chat",
  );
  expect(screen.getByRole("textbox", { name: /^Instructions/ })).toHaveValue(
    "Next Canvas",
  );
  expect(screen.getByRole("radio", { name: /^Temporary/ })).toBeChecked();
  expect(h.sign).toHaveBeenCalledOnce();
  expect(h.publish).toHaveBeenCalledOnce();
  expect(h.close).not.toHaveBeenCalled();
});

it.each(["before", "rebase", "clear"] as const)(
  "device persistence failure %s is truthful and retry does not replay confirmed writes",
  async (stage) => {
    const h = combined();
    await editBoth();
    const original = Storage.prototype.setItem;
    let calls = 0;
    const storage = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(function (this: Storage, key, value) {
        calls++;
        if (calls === ({ before: 1, rebase: 2, clear: 3 } as const)[stage])
          throw new Error("Device full");
        original.call(this, key, value);
      });
    try {
      fireEvent.click(saveChanges());
      expect(await screen.findByRole("alert")).toHaveTextContent(
        stage === "before"
          ? "No new changes were sent"
          : stage === "rebase"
            ? "Name and lifetime were not sent"
            : "Changes are confirmed",
      );
      expect(h.close).not.toHaveBeenCalled();
      expect(h.canvas.save).toHaveBeenCalledTimes(stage === "before" ? 0 : 1);
      expect(h.publish).toHaveBeenCalledTimes(stage === "clear" ? 1 : 0);
    } finally {
      storage.mockRestore();
    }
    fireEvent.click(saveChanges());
    await waitFor(() => expect(h.close).toHaveBeenCalledOnce());
    expect(h.canvas.save).toHaveBeenCalledOnce();
    expect(h.publish).toHaveBeenCalledOnce();
  },
);

it("validates the complete Canvas byte budget before either write", async () => {
  const h = combined();
  await editBoth();
  fireEvent.change(screen.getByRole("textbox", { name: /^Instructions/ }), {
    target: { value: "🙂".repeat(LIVE_CANVAS_BYTES / 4 + 1) },
  });
  fireEvent.click(saveChanges());
  expect(await screen.findByRole("alert")).toHaveTextContent(LIVE_CANVAS_LIMIT);
  expect(h.canvas.save).not.toHaveBeenCalled();
  expect(h.sign).not.toHaveBeenCalled();
});

it.each(["visit", "unmount"])(
  "%s after Canvas admission allows its receipt but fences later lifetime and close",
  async (retire) => {
    const h = combined();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.canvas.save.mockImplementationOnce(async (_id, content) => {
      await held;
      return { id: "revision-two", content };
    });
    await editBoth();
    fireEvent.click(saveChanges());
    try {
      await waitFor(() => expect(h.canvas.save).toHaveBeenCalledOnce());
      expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
      if (retire === "visit") h.visit.abort();
      else h.mounted.unmount();
    } finally {
      await act(async () => {
        release();
        await held;
      });
    }
    expect(readView("test", draftKey(h.id), null)).toMatchObject({
      base: "revision-two",
    });
    expect(h.sign).not.toHaveBeenCalled();
    expect(h.close).not.toHaveBeenCalled();
    if (retire === "visit") {
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled(),
      );
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(h.close).toHaveBeenCalledOnce();
    }
  },
);

it("a failed details read leaves Canvas usable without sending a default lifetime", async () => {
  const h = combined();
  // Fresh instance with independently failed details, not a mocked hook.
  h.mounted.unmount();
  h.read.mockRejectedValueOnce(new Error("Details unavailable"));
  render(h.view());
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Details unavailable",
  );
  fireEvent.change(
    await screen.findByRole("textbox", { name: /^Instructions/ }),
    {
      target: { value: "Canvas only" },
    },
  );
  fireEvent.click(saveChanges());
  await waitFor(() => expect(h.close).toHaveBeenCalledOnce());
  expect(h.canvas.save).toHaveBeenCalledOnce();
  expect(h.sign).not.toHaveBeenCalled();
});

it("a failed Canvas read leaves the loaded lifetime usable without publishing Canvas", async () => {
  const h = combined();
  h.mounted.unmount();
  h.canvas.read.mockRejectedValueOnce(new Error("Canvas unavailable"));
  render(h.view());
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Canvas unavailable",
  );
  await waitFor(() =>
    expect(screen.getByRole("radio", { name: /^Ongoing/ })).not.toHaveAttribute(
      "aria-disabled",
      "true",
    ),
  );
  fireEvent.click(screen.getByRole("radio", { name: /^Ongoing/ }));
  fireEvent.click(saveChanges());
  await waitFor(() => expect(h.close).toHaveBeenCalledOnce());
  expect(h.canvas.save).not.toHaveBeenCalled();
  expect(h.publish).toHaveBeenCalledOnce();
});

it("saves name and lifetime together after Canvas; clearing later preserves the confirmed title", async () => {
  const h = combined();
  await editBoth();
  const name = screen.getByRole("textbox", { name: "Chat name" });
  fireEvent.change(name, { target: { value: "  Better name  " } });
  fireEvent.click(saveChanges());
  await waitFor(() => expect(h.close).toHaveBeenCalledOnce());
  expect(h.sign.mock.calls[0]?.[0].tags).toEqual([
    ["h", h.id],
    ["name", "Better name"],
    ["about", ""],
    ["ttl", ""],
    ["t", SOLO_LABEL],
    ["t", "buzz.session.named"],
  ]);
  expect(h.canvas.save.mock.invocationCallOrder[0]).toBeLessThan(
    h.sign.mock.invocationCallOrder[0] ?? 0,
  );
  h.mounted.unmount();
  render(h.view());
  fireEvent.change(await screen.findByRole("textbox", { name: "Chat name" }), {
    target: { value: "" },
  });
  fireEvent.click(saveChanges());
  await waitFor(() => expect(h.close).toHaveBeenCalledTimes(2));
  expect(h.sign).toHaveBeenCalledOnce();
  expect(await h.details.capability.load(h.id)).toMatchObject({
    name: "Better name",
    description: "",
  });
  expect(h.canvas.save).toHaveBeenCalledOnce();
});
it("historical blank name preserves the saved title and Solo metadata", async () => {
  const h = combined();
  const name = await screen.findByRole("textbox", {
    name: "Chat name",
  });
  expect(name).toHaveValue("Plan");
  expect(name).toHaveAttribute("placeholder", "Plan");
  expect(name).not.toHaveAccessibleDescription();
  fireEvent.change(name, { target: { value: "  " } });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(saveChanges()).toBeEnabled();
  fireEvent.click(saveChanges());
  await waitFor(() => expect(h.close).toHaveBeenCalledOnce());
  expect(h.sign).not.toHaveBeenCalled();
  expect(h.canvas.save).not.toHaveBeenCalled();
  expect(await h.details.capability.load(h.id)).toMatchObject({
    name: "Plan",
    description: "",
  });
  h.mounted.unmount();
  render(h.view());
  expect(await screen.findByRole("textbox", { name: "Chat name" })).toHaveValue(
    "Plan",
  );
});
it("a conflicted name retains input across explicit reload and rechecks real signed authority", async () => {
  const h = combined();
  await editBoth();
  fireEvent.change(screen.getByRole("textbox", { name: "Chat name" }), {
    target: { value: "Keep my name" },
  });
  h.rename("Elsewhere");
  fireEvent.click(saveChanges());
  expect(await screen.findByRole("alert")).toHaveTextContent("changed");
  expect(h.publish).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Reload chat details" }));
  await waitFor(() => expect(saveChanges()).toBeEnabled());
  expect(screen.queryByRole("alert")).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Review saved settings" }),
  ).toBeNull();
  expect(screen.getByRole("textbox", { name: "Chat name" })).toHaveValue(
    "Keep my name",
  );
  fireEvent.click(saveChanges());
  await waitFor(() => expect(h.close).toHaveBeenCalledOnce());
  expect(h.canvas.save).toHaveBeenCalledOnce();
  expect(h.publish).toHaveBeenCalledOnce();
});
it("uncertain name survives remount and reconciles without publishing or saving newer Canvas edits", async () => {
  const h = combined();
  await editBoth();
  fireEvent.change(screen.getByRole("textbox", { name: "Chat name" }), {
    target: { value: "Frozen name" },
  });
  h.publish.mockRejectedValueOnce(new Error("Lost ack"));
  fireEvent.click(saveChanges());
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "may have been saved",
  );
  h.mounted.unmount();
  render(h.view());
  const check = await screen.findByRole("button", {
    name: "Check save status",
  });
  await waitFor(() => expect(check).toBeEnabled());
  expect(screen.getByRole("textbox", { name: "Chat name" })).toHaveValue(
    "Frozen name",
  );
  fireEvent.change(screen.getByRole("textbox", { name: /^Instructions/ }), {
    target: { value: "Next Canvas" },
  });
  const sent = h.sign.mock.calls[0]?.[0];
  expect(sent).toBeDefined();
  if (sent) h.apply(sent);
  fireEvent.click(check);
  await waitFor(() => expect(saveChanges()).toBeEnabled());
  expect(h.close).not.toHaveBeenCalled();
  expect(h.publish).toHaveBeenCalledOnce();
  expect(h.canvas.save).toHaveBeenCalledOnce();
});

it("shared name validation blocks oversized names before either owner publishes", async () => {
  const h = combined();
  await editBoth();
  const name = screen.getByRole("textbox", { name: "Chat name" });
  fireEvent.change(name, { target: { value: "🙂".repeat(121) } });
  expect(saveChanges()).toBeDisabled();
  expect(name).toBeEnabled();
  expect(name).toHaveAccessibleDescription(
    "Use a chat name of at most 120 characters.",
  );
  expect(screen.getByRole("radio", { name: /^Temporary/ })).not.toHaveAttribute(
    "aria-disabled",
    "true",
  );
  expect(screen.getByRole("radio", { name: /^Ongoing/ })).not.toHaveAttribute(
    "aria-disabled",
    "true",
  );
  expect(h.canvas.save).not.toHaveBeenCalled();
  expect(h.sign).not.toHaveBeenCalled();
});

it("a saved title stays visible during a lifetime-only save", async () => {
  const h = combined();
  await editBoth();
  expect(screen.getByRole("textbox", { name: "Chat name" })).toHaveValue(
    "Plan",
  );
  fireEvent.click(saveChanges());
  await waitFor(() => expect(h.close).toHaveBeenCalledOnce());
  expect(h.sign.mock.calls[0]?.[0].tags).toEqual([
    ["h", h.id],
    ["name", "Plan"],
    ["about", ""],
    ["ttl", ""],
  ]);
});

// A chat's settings with Canvas only; tests that need details use combined().
function chat(
  save = vi.fn(async (_id: string, content: string, _base?: string) => ({
    id: "revision-two",
    content,
  })),
) {
  const close = vi.fn();
  const session = {
    canvas: {
      available: true,
      read: async () => ({ id: "revision-one", content: "Original" }),
      save,
    },
  } as unknown as RelaySession;
  const view = () => (
    <WorkspaceSettings
      session={session}
      scope="test"
      target={{ kind: "chat", id: "chat", name: "Plan" }}
      close={close}
    />
  );
  return { close, save, view, mounted: render(view()) };
}
const instructions = () =>
  screen.findByRole("textbox", { name: /^Instructions/ });
const prompt = () =>
  screen.findByRole("alertdialog", { name: "Discard changes?" });
const backdrop = () =>
  [...document.querySelectorAll(".buzz-dialog-backdrop")].at(-1) as Element;

it.each(["Escape", "Close", "backdrop"] as const)(
  "asks before %s drops a chat's unsaved settings, and Keep editing keeps them",
  async (dismiss) => {
    const user = userEvent.setup();
    const h = chat();
    const field = await instructions();
    fireEvent.change(field, { target: { value: "My draft" } });
    const settings = screen.getByRole("dialog", { name: "Edit chat" });
    if (dismiss === "Escape") await user.keyboard("{Escape}");
    else if (dismiss === "Close")
      await user.click(within(settings).getByRole("button", { name: "Close" }));
    else await user.click(backdrop());
    const asked = await prompt();
    expect(asked).toHaveAccessibleDescription(
      "Your settings have unsaved changes.",
    );
    const keep = within(asked).getByRole("button", { name: "Keep editing" });
    await waitFor(() => expect(keep).toHaveFocus());
    // The prompt needs a deliberate answer; its own backdrop does nothing.
    await user.click(backdrop());
    expect(asked).toBeVisible();
    await user.click(keep);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(screen.getByRole("dialog", { name: "Edit chat" })).toBe(settings);
    if (dismiss === "Close")
      await waitFor(() =>
        expect(
          within(settings).getByRole("button", { name: "Close" }),
        ).toHaveFocus(),
      );
    expect(field).toHaveValue("My draft");
    expect(h.close).not.toHaveBeenCalled();
  },
);

it("closes untouched settings at once, and Cancel discards edits without asking", async () => {
  const user = userEvent.setup();
  const h = chat();
  const field = await instructions();
  await user.keyboard("{Escape}");
  await user.click(backdrop());
  expect(h.close).toHaveBeenCalledTimes(2);
  fireEvent.change(field, { target: { value: "My draft" } });
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(h.close).toHaveBeenCalledTimes(3);
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(h.save).not.toHaveBeenCalled();
});

function project(entries: unknown[] = []) {
  const close = vi.fn();
  const session = {
    scope: "https://relay.example.test:viewer",
    channelKit: {
      refresh: async () => {},
      snapshot: () => ({ status: "ready", entries }),
      save: vi.fn(),
    },
  } as unknown as RelaySession;
  render(
    <WorkspaceSettings
      session={session}
      scope="test"
      target={{ kind: "project", id: "work", name: "Work" }}
      close={close}
    />,
  );
  return { close };
}

it("asks before closing Workspace settings with edited instructions", async () => {
  const user = userEvent.setup();
  const h = project();
  fireEvent.change(await instructions(), {
    target: { value: "Work carefully" },
  });
  await user.click(
    within(
      screen.getByRole("dialog", { name: "Workspace settings" }),
    ).getByRole("button", { name: "Close" }),
  );
  expect(await prompt()).toBeVisible();
  expect(h.close).not.toHaveBeenCalled();
});

it("asks before closing Workspace settings with a different agent lineup", async () => {
  const user = userEvent.setup();
  const template = (id: string, name: string, agent: string) => ({
    eventId: `${id}-event`,
    createdAt: 1,
    record: {
      version: 2,
      community: "https://relay.example.test",
      deleted: false,
      value: {
        type: "template",
        id,
        name,
        description: "",
        agents: [agent.repeat(64)],
        teamIds: [],
        canvas: "Shared",
      },
    },
  });
  const h = project([
    template(await projectTemplateId("work"), "Work chats", "a"),
    template("review", "Review kit", "b"),
  ]);
  expect(await instructions()).toHaveValue("Shared");
  // The saved defaults' agents are where the dialog starts, not an edit.
  await user.keyboard("{Escape}");
  expect(h.close).toHaveBeenCalledOnce();
  // Review kit changes only the agents; its instructions are the same.
  const choice = screen.getByRole("combobox", {
    name: "Start from a template",
  });
  await user.click(choice);
  await user.click(await screen.findByRole("option", { name: "Review kit" }));
  await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
  expect(await instructions()).toHaveValue("Shared");
  await user.keyboard("{Escape}");
  await user.click(
    within(await prompt()).getByRole("button", { name: "Keep editing" }),
  );
  expect(choice).toHaveTextContent("Review kit");
  expect(h.close).toHaveBeenCalledOnce();
});

it.each(["name", "lifetime"] as const)(
  "asks before Escape drops an edited chat %s",
  async (edit) => {
    const user = userEvent.setup();
    const h = combined();
    const name = await screen.findByRole("textbox", { name: "Chat name" });
    const ongoing = screen.getByRole("radio", { name: /^Ongoing/ });
    await waitFor(() =>
      expect(ongoing).not.toHaveAttribute("aria-disabled", "true"),
    );
    await instructions();
    // Loaded details are not an edit.
    await user.keyboard("{Escape}");
    expect(h.close).toHaveBeenCalledOnce();
    if (edit === "name")
      fireEvent.change(name, { target: { value: "Better name" } });
    else fireEvent.click(ongoing);
    await user.keyboard("{Escape}");
    expect(await prompt()).toBeVisible();
    expect(h.close).toHaveBeenCalledOnce();
  },
);

it("a kept draft from a failed save closes without asking and reopens intact", async () => {
  const user = userEvent.setup();
  const h = chat(
    vi.fn(async () => {
      throw new Error("Canvas changed elsewhere");
    }),
  );
  fireEvent.change(await instructions(), { target: { value: "My draft" } });
  // A draft this device couldn't keep still asks.
  const storage = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementationOnce(() => {
      throw new Error("Device full");
    });
  try {
    fireEvent.click(saveChanges());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "No new changes were sent",
    );
  } finally {
    storage.mockRestore();
  }
  await user.keyboard("{Escape}");
  await user.click(
    within(await prompt()).getByRole("button", { name: "Keep editing" }),
  );
  fireEvent.click(saveChanges());
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Canvas changed elsewhere",
  );
  await user.keyboard("{Escape}");
  expect(h.close).toHaveBeenCalledOnce();
  expect(screen.queryByRole("alertdialog")).toBeNull();
  h.mounted.unmount();
  render(h.view());
  expect(await instructions()).toHaveValue("My draft");
  // The restored draft is what reopening shows, so it isn't an edit either.
  await user.keyboard("{Escape}");
  expect(h.close).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("alertdialog")).toBeNull();
});

it.each([
  ["closes without asking after an uncertain", new Error("Lost ack"), false],
  ["asks after a refused", new PublishRejected("Lifetime refused"), true],
] as const)(
  "%s lifetime save once Canvas is confirmed",
  async (_, failure, asks) => {
    const user = userEvent.setup();
    const h = combined();
    h.publish.mockRejectedValueOnce(failure);
    await editBoth();
    fireEvent.click(saveChanges());
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled(),
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      asks ? "Lifetime refused" : "may have been saved",
    );
    await user.keyboard("{Escape}");
    if (asks) {
      // A refused lifetime is held only by this dialog.
      expect(await prompt()).toBeVisible();
      expect(h.close).not.toHaveBeenCalled();
      return;
    }
    // An uncertain one stays with its owner and reopens to be checked.
    expect(h.close).toHaveBeenCalledOnce();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    h.mounted.unmount();
    render(h.view());
    expect(
      await screen.findByRole("button", { name: "Check save status" }),
    ).toBeVisible();
    expect(await instructions()).toHaveValue("Draft Canvas");
    expect(screen.getByRole("radio", { name: /^Ongoing/ })).toBeChecked();
  },
);

it("a saving dialog ignores Escape, Close and outside clicks", async () => {
  const user = userEvent.setup();
  const h = combined();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  h.canvas.save.mockImplementationOnce(async (_id, content) => {
    await held;
    return { id: "revision-two", content };
  });
  await editBoth();
  fireEvent.click(saveChanges());
  try {
    await waitFor(() => expect(h.canvas.save).toHaveBeenCalledOnce());
    expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
    await user.keyboard("{Escape}");
    await user.click(backdrop());
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(h.close).not.toHaveBeenCalled();
  } finally {
    await act(async () => {
      release();
      await held;
    });
  }
  await waitFor(() => expect(h.close).toHaveBeenCalledOnce());
  expect(screen.queryByRole("alertdialog")).toBeNull();
});
