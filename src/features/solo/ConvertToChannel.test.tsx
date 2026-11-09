// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { finalizeEvent, getPublicKey, type EventTemplate } from "nostr-tools";
import { createChannelDetails } from "../relay/channel-details";
import { createRelaySession } from "../relay/session";
import { PublishRejected } from "../relay/outbox";
import { SOLO_LABEL } from "./labels";
import { chatConversion, conversionLabel } from "./conversion";
import { ConvertToChannel, canConvertToChannel } from "./ConvertToChannel";

const id = "11111111-1111-4111-8111-111111111111";
const key = new Uint8Array(32).fill(2),
  relayKey = new Uint8Array(32).fill(3);
const viewer = getPublicKey(key),
  relayAuthor = getPublicKey(relayKey);
const dispose: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const close of dispose.splice(0)) close();
});
function setup(
  solo = true,
  initialVisibility: "private" | "public" = "private",
  initialJoinRole: "member" | "guest" | undefined = undefined,
) {
  let clock = 100,
    role = "owner",
    name = "Original",
    visibility = initialVisibility,
    joinRole = initialJoinRole;
  let labels = solo ? [SOLO_LABEL, "work"] : ["work"];
  const record = (kind: number, tags: string[][]) =>
    finalizeEvent(
      { kind, tags: [["d", id], ...tags], content: "", created_at: clock },
      relayKey,
    );
  const metadata = () =>
    record(39000, [
      ["name", name],
      ["about", "Notes"],
      ["t", "stream"],
      ...labels.map((label) => ["t", label]),
      [visibility],
      ...(joinRole ? [["join_role", joinRole]] : []),
      ["ttl", "86400"],
    ]);
  const read = vi.fn(async () => [
    metadata(),
    record(39001, role === "member" ? [] : [["p", viewer, role]]),
    record(39002, [["p", viewer, "", role]]),
  ]);
  const sign = vi.fn(async (template: EventTemplate) =>
    finalizeEvent(structuredClone(template), key),
  );
  const publish = vi.fn(async (event: import("../relay/events").RelayEvent) => {
    const written = event.tags.flatMap(([tag, value]) =>
      tag === "t" && value !== undefined ? [value] : [],
    );
    if (written.length) labels = written.filter(Boolean);
    const choice = event.tags.find(([tag]) => tag === "visibility")?.[1];
    if (choice) visibility = choice === "open" ? "public" : "private";
    const admission = event.tags.find(([tag]) => tag === "join_role")?.[1];
    if (admission === "member" || admission === "guest") joinRole = admission;
    clock++;
  });
  const details = createChannelDetails({
    reader: { read },
    writer: { sign, publish },
    viewer,
    relayAuthor,
    labels: true,
    canAccess: () => true,
    acceptDiscovery: () => {},
  });
  const owner = createRelaySession(null);
  dispose.push(details.dispose, owner.dispose);
  const projects = (assignments: Record<string, string>) => ({
    status: "ready" as const,
    data: {
      sections: [{ id: "g", name: "Project", order: 0 }],
      assignments,
      starred: [],
      muted: [],
    },
  });
  const filedProjects = projects({ [id]: "g" });
  const unfiledProjects = projects({});
  let filed = true;
  const unfile = vi.fn(async (_id: string, _sectionId?: string) => {
    filed = false;
    return { sections: [], assignments: {}, starred: [], muted: [] };
  });
  const projectsRefresh = vi.fn(async () => {});
  const session = {
    ...owner.session,
    channelDetails: details.capability,
    soloPreferences: {
      ...owner.session.soloPreferences,
      snapshot: () => (filed ? filedProjects : unfiledProjects),
      refresh: projectsRefresh,
      assign: unfile,
    },
  };
  const close = vi.fn();
  const converted = vi.fn();
  const visit = new AbortController();
  const mounted = render(
    <ConvertToChannel
      session={session}
      id={id}
      signal={visit.signal}
      close={close}
      onConverted={converted}
    />,
  );
  return {
    session,
    close,
    convertedCallback: converted,
    unfile,
    projectsRefresh,
    read,
    sign,
    publish,
    visit,
    mounted,
    details,
    authority: (next: string) => {
      role = next;
    },
    rename: () => {
      name = "Changed";
      clock++;
    },
    admission: (next: "member" | "guest") => {
      joinRole = next;
      clock++;
    },
    converted: (
      next: "private" | "public" = "private",
      admission: "member" | "guest" | undefined = next === "public"
        ? "member"
        : joinRole,
    ) => {
      labels = labels.filter((label) => label !== SOLO_LABEL);
      visibility = next;
      joinRole = admission;
      clock++;
    },
  };
}
const confirm = () =>
  screen.getByRole("button", { name: "Convert to channel" });
const accessControl = () =>
  screen.getByRole("combobox", { name: "General access" });
async function selectAccess(label: string) {
  const user = userEvent.setup();
  await user.click(accessControl());
  await user.click(await screen.findByRole("option", { name: label }));
}
async function ready() {
  await waitFor(() => expect(confirm()).toBeEnabled());
}
it("starts on Cancel so Enter does not convert or publish", async () => {
  const h = setup();
  await ready();
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus(),
  );
  await userEvent.setup().keyboard("{Enter}");
  await waitFor(() => expect(h.close).toHaveBeenCalledOnce());
  expect(h.publish).not.toHaveBeenCalled();
  expect(h.unfile).not.toHaveBeenCalled();
});

it("preselects View only and preserves Guest admission when converting a view-only Solo chat", async () => {
  const h = setup(true, "public", "guest");
  await ready();
  expect(accessControl()).toHaveTextContent("View only");
  fireEvent.click(confirm());
  await waitFor(() => expect(h.close).toHaveBeenCalledOnce());
  expect(h.publish).toHaveBeenCalledOnce();
  expect(h.sign.mock.calls[0]?.[0].tags).not.toContainEqual([
    "visibility",
    "private",
  ]);
  expect(await h.details.capability.load(id)).toMatchObject({
    visibility: "public",
    joinRole: "guest",
    labels: ["work"],
    ttlSeconds: 86400,
  });
});
it.each(["private", "public"])(
  "converts through signed kind 9002 with explicit %s visibility and unchanged TTL",
  async (visibility) => {
    const h = setup();
    await ready();
    expect(accessControl()).toHaveTextContent("Private");
    const user = userEvent.setup();
    await user.click(accessControl());
    expect(
      await screen.findByRole("option", { name: "Public" }),
    ).toHaveAccessibleDescription("Anyone in the community can participate.");
    await user.keyboard("{Escape}");
    if (visibility === "public") await selectAccess("Public");
    expect(h.sign).not.toHaveBeenCalled();
    fireEvent.click(confirm());
    await waitFor(() => expect(h.close).toHaveBeenCalledOnce());
    expect(h.publish).toHaveBeenCalledOnce();
    expect(h.unfile).toHaveBeenCalledExactlyOnceWith(id, undefined);
    expect(h.convertedCallback).toHaveBeenCalledOnce();
    expect(h.publish.mock.invocationCallOrder[0]).toBeLessThan(
      h.unfile.mock.invocationCallOrder[0] ?? 0,
    );
    expect(chatConversion(h.session, id)).toBeUndefined();
    const event = h.sign.mock.calls[0]?.[0];
    expect(event?.kind).toBe(9002);
    expect(event?.tags).toEqual([
      ["h", id],
      ["name", "Original"],
      ["about", "Notes"],
      ...(visibility === "public" ? [["visibility", "open"]] : []),
      ["t", "work"],
    ]);
    const saved = await h.details.capability.load(id);
    expect(saved).toMatchObject({
      name: "Original",
      description: "Notes",
      visibility,
      ttlSeconds: 86400,
      labels: ["work"],
    });
  },
);

const policies = [
  { label: "Private", visibility: "private", joinRole: "guest" },
  { label: "View only", visibility: "public", joinRole: "guest" },
  { label: "Public", visibility: "public", joinRole: "member" },
] as const;
it.each(policies.flatMap((from) => policies.map((to) => ({ from, to }))))(
  "converts $from.label → $to.label with the selected admission policy",
  async ({ from, to }) => {
    const h = setup(true, from.visibility, from.joinRole);
    await ready();
    expect(accessControl()).toHaveTextContent(from.label);
    const user = userEvent.setup();
    await user.click(accessControl());
    expect(await screen.findAllByRole("option")).toHaveLength(3);
    expect(
      screen.getByRole("option", { name: "View only" }),
    ).toHaveAccessibleDescription("Anyone in the community can read.");
    await user.click(screen.getByRole("option", { name: to.label }));
    const disclosure = screen.queryByText(
      "Everyone in this community will be able to read this chat’s full history and Canvas, including its workspace folders and agent instructions.",
      { exact: false },
    );
    if (from.visibility === "private" && to.visibility === "public") {
      expect(disclosure).toBeVisible();
      expect(screen.getByRole("dialog")).toHaveAccessibleDescription(
        disclosure?.textContent,
      );
    } else expect(disclosure).not.toBeInTheDocument();
    if (from.visibility === "public" && to.visibility === "private") {
      expect(screen.getByRole("dialog")).toHaveAccessibleDescription(
        from.joinRole === "guest"
          ? "People who joined while it was View only are members and keep reading until you remove them in People."
          : "People who already joined remain members and keep their access until you remove them in People.",
      );
    }
    expect(h.publish).not.toHaveBeenCalled();
    fireEvent.click(confirm());
    await waitFor(() => expect(h.close).toHaveBeenCalledOnce());
    expect(h.publish).toHaveBeenCalledOnce();
    expect(await h.details.capability.load(id)).toMatchObject({
      visibility: to.visibility,
      joinRole: to.visibility === "private" ? from.joinRole : to.joinRole,
      labels: ["work"],
      ttlSeconds: 86400,
    });
  },
);

it("preselects Public when the open chat has the default Member admission", async () => {
  setup(true, "public", undefined);
  await ready();
  expect(accessControl()).toHaveTextContent("Public");
});

it("retires superseded View-only recovery after Finish rejects changed admission and reload/remount", async () => {
  const h = setup(true, "public", "member");
  await ready();
  await selectAccess("View only");
  h.publish.mockRejectedValueOnce(new Error("lost acknowledgment"));
  fireEvent.click(confirm());
  await screen.findByRole("alert");
  h.mounted.unmount();
  h.converted("public", "guest");
  await h.session.channelDetails.check(id);
  render(<ConvertToChannel session={h.session} id={id} close={h.close} />);
  const finish = await screen.findByRole("button", {
    name: "Finish conversion",
  });
  expect(accessControl()).toHaveTextContent("View only");
  h.admission("member");
  fireEvent.click(finish);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "settings changed",
  );
  expect(h.unfile).not.toHaveBeenCalled();
  expect(chatConversion(h.session, id)).toBeUndefined();
  fireEvent.click(screen.getByRole("button", { name: "Reload chat details" }));
  await screen.findByText("Only a Solo chat can be converted.");
  expect(
    screen.queryByRole("button", { name: "Finish conversion" }),
  ).toBeNull();
  expect(confirm()).toBeDisabled();
  cleanup();
  render(<ConvertToChannel session={h.session} id={id} close={h.close} />);
  await screen.findByText("Only a Solo chat can be converted.");
  expect(
    screen.queryByRole("button", { name: "Finish conversion" }),
  ).toBeNull();
  expect(conversionLabel(h.session, id)).toBe("Convert to channel");
  expect(
    canConvertToChannel(h.session, {
      id,
      name: "Original",
      channelType: "stream",
    }),
  ).toBe(false);
  expect(h.close).not.toHaveBeenCalled();
  expect(h.unfile).not.toHaveBeenCalled();
  expect(h.publish).toHaveBeenCalledOnce();
});

it("does not offer completion when the confirmed conversion has different admission", async () => {
  const h = setup(true, "public", "guest");
  await ready();
  h.publish.mockRejectedValueOnce(new Error("lost acknowledgment"));
  fireEvent.click(confirm());
  await screen.findByRole("alert");
  h.mounted.unmount();
  h.converted("public", "guest");
  await h.session.channelDetails.check(id);
  h.admission("member");
  render(<ConvertToChannel session={h.session} id={id} close={h.close} />);
  await screen.findByText("Only a Solo chat can be converted.");
  expect(
    screen.queryByRole("button", { name: "Finish conversion" }),
  ).toBeNull();
  expect(confirm()).toBeDisabled();
  expect(h.unfile).not.toHaveBeenCalled();
  expect(chatConversion(h.session, id)).toBeUndefined();
});

it("keeps Finish recovery after a transient read failure and completes without republishing", async () => {
  const h = setup(true, "public", "guest");
  await ready();
  h.publish.mockRejectedValueOnce(new Error("lost acknowledgment"));
  fireEvent.click(confirm());
  await screen.findByRole("alert");
  h.mounted.unmount();
  h.converted("public", "guest");
  await h.session.channelDetails.check(id);
  render(<ConvertToChannel session={h.session} id={id} close={h.close} />);
  const finish = await screen.findByRole("button", {
    name: "Finish conversion",
  });
  const receipt = chatConversion(h.session, id);
  h.read.mockRejectedValueOnce(new Error("Details unavailable"));
  fireEvent.click(finish);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Details unavailable",
  );
  expect(chatConversion(h.session, id)).toBe(receipt);
  await waitFor(() => expect(finish).toBeEnabled());
  fireEvent.click(finish);
  await waitFor(() => expect(h.close).toHaveBeenCalledOnce());
  expect(h.publish).toHaveBeenCalledOnce();
  expect(h.unfile).toHaveBeenCalledOnce();
});
it.each(["authority", "conflict"])(
  "fresh %s prevents conversion and reload explicitly recovers",
  async (change) => {
    const h = setup();
    await ready();
    if (change === "authority") h.authority("member");
    else h.rename();
    fireEvent.click(confirm());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      change === "authority" ? "permission" : "changed",
    );
    expect(h.publish).not.toHaveBeenCalled();
    expect(h.close).not.toHaveBeenCalled();
    h.authority("admin");
    fireEvent.click(
      screen.getByRole("button", { name: "Reload chat details" }),
    );
    await ready();
    fireEvent.click(confirm());
    await waitFor(() => expect(h.close).toHaveBeenCalledOnce());
    expect(h.publish).toHaveBeenCalledOnce();
    expect(h.sign.mock.calls[0]?.[0].tags).toContainEqual(["t", "work"]);
    expect((await h.details.capability.load(id)).labels).toEqual(["work"]);
  },
);
it.each([
  { visibility: "private", failedRead: false },
  { visibility: "public", failedRead: true },
] as const)(
  "unknown $visibility conversion checks status without resending after remount, failed initial read=$failedRead",
  async ({ visibility, failedRead }) => {
    const h = setup();
    h.publish.mockRejectedValueOnce(new Error("lost acknowledgement"));
    await ready();
    if (visibility === "public") await selectAccess("Public");
    fireEvent.click(confirm());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "may have been saved",
    );
    h.mounted.unmount();
    const pending = h.details.capability.snapshot(id);
    if (failedRead)
      h.read.mockRejectedValueOnce(new Error("Details unavailable"));
    render(<ConvertToChannel session={h.session} id={id} close={h.close} />);
    if (failedRead) {
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Details unavailable",
      );
      expect(confirm()).toBeDisabled();
      expect(screen.queryByRole("button", { name: "Check status" })).toBeNull();
      expect(h.details.capability.snapshot(id)).toBe(pending);
      expect(accessControl()).toHaveTextContent(
        visibility === "public" ? "Public" : "Private",
      );
      expect(accessControl()).toBeDisabled();
      fireEvent.click(
        screen.getByRole("button", { name: "Reload chat details" }),
      );
    }
    const check = await screen.findByRole("button", { name: "Check status" });
    expect(h.details.capability.snapshot(id)).toBe(pending);
    expect(accessControl()).toHaveTextContent(
      visibility === "public" ? "Public" : "Private",
    );
    expect(accessControl()).toBeDisabled();
    fireEvent.keyDown(accessControl(), { key: "ArrowDown" });
    expect(accessControl()).toHaveTextContent(
      visibility === "public" ? "Public" : "Private",
    );
    expect(h.sign).toHaveBeenCalledOnce();
    expect(h.publish).toHaveBeenCalledOnce();
    fireEvent.click(check);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "may have been saved",
    );
    expect(h.publish).toHaveBeenCalledOnce();
    h.converted(visibility);
    fireEvent.click(check);
    await waitFor(() => expect(h.close).toHaveBeenCalledOnce());
    expect(h.sign).toHaveBeenCalledOnce();
    expect(h.publish).toHaveBeenCalledOnce();
  },
);
it("definitive rejection permits explicit retry without losing the confirmation", async () => {
  const h = setup();
  h.publish.mockRejectedValueOnce(new PublishRejected("Denied"));
  await ready();
  fireEvent.click(confirm());
  expect(await screen.findByRole("alert")).toHaveTextContent("Denied");
  await ready();
  fireEvent.click(confirm());
  await waitFor(() => expect(h.close).toHaveBeenCalledOnce());
  expect(h.publish).toHaveBeenCalledTimes(2);
});
it("a chat without the Solo label cannot convert", async () => {
  const h = setup(false);
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent("Only a Solo chat"),
  );
  expect(confirm()).toBeDisabled();
  expect(h.publish).not.toHaveBeenCalled();
});
it.each(["visit", "unmount"])(
  "%s during signing prevents publication and late modal close",
  async (retire) => {
    const h = setup();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.sign.mockImplementationOnce(async (template) => {
      await held;
      return finalizeEvent(template, key);
    });
    await ready();
    fireEvent.click(confirm());
    try {
      await waitFor(() => expect(h.sign).toHaveBeenCalledOnce());
      expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
      if (retire === "visit") h.visit.abort();
      else h.mounted.unmount();
    } finally {
      await act(async () => {
        release();
        await held;
      });
    }
    await waitFor(() =>
      expect(h.details.capability.snapshot(id)).toBeUndefined(),
    );
    expect(h.publish).not.toHaveBeenCalled();
    expect(h.close).not.toHaveBeenCalled();
    if (retire === "visit") {
      const cancel = screen.getByRole("button", { name: "Cancel" });
      await waitFor(() => expect(cancel).toBeEnabled());
      fireEvent.click(cancel);
      expect(h.close).toHaveBeenCalledOnce();
    }
  },
);

it("an unrelated unconfirmed metadata change cannot be checked as conversion", async () => {
  const h = setup();
  await ready();
  const base = await h.details.capability.load(id);
  h.publish.mockRejectedValueOnce(new Error("lost acknowledgement"));
  await act(async () => {
    await h.details.capability
      .save(base, { ...base, name: "Other edit" })
      .catch(() => {});
  });
  expect(screen.getByRole("status")).toHaveTextContent("Finish the existing");
  expect(screen.queryByRole("button", { name: "Check status" })).toBeNull();
  expect(confirm()).toBeDisabled();
  expect(h.publish).toHaveBeenCalledOnce();
});

it("retries only project unfiling after confirmed conversion and remount", async () => {
  const h = setup();
  h.unfile.mockRejectedValueOnce(new Error("Projects save unavailable"));
  await ready();
  await selectAccess("Public");
  fireEvent.click(confirm());
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Projects save unavailable",
  );
  expect(chatConversion(h.session, id)?.converted).toBe(true);
  expect(h.convertedCallback).not.toHaveBeenCalled();
  expect(h.close).not.toHaveBeenCalled();
  expect(
    canConvertToChannel(h.session, {
      id,
      name: "Original",
      channelType: "stream",
    }),
  ).toBe(true);
  h.mounted.unmount();
  render(
    <ConvertToChannel
      session={h.session}
      id={id}
      close={h.close}
      onConverted={h.convertedCallback}
    />,
  );
  expect(
    screen.getByText(
      "Channel converted. Finish removing it from its Solo workspace.",
    ),
  ).toBeVisible();
  expect(accessControl()).toHaveTextContent("Public");
  fireEvent.click(screen.getByRole("button", { name: "Finish conversion" }));
  await waitFor(() => expect(h.convertedCallback).toHaveBeenCalledOnce());
  expect(h.publish).toHaveBeenCalledOnce();
  expect(h.sign).toHaveBeenCalledOnce();
  expect(h.unfile).toHaveBeenCalledTimes(2);
  expect(chatConversion(h.session, id)).toBeUndefined();
});
it.each(["visit", "unmount"])(
  "retains converted recovery but suppresses completion after %s during unfiling",
  async (retire) => {
    const h = setup();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.unfile.mockImplementationOnce(async () => {
      await held;
      return { sections: [], assignments: {}, starred: [], muted: [] };
    });
    await ready();
    fireEvent.click(confirm());
    try {
      await waitFor(() => expect(h.unfile).toHaveBeenCalledOnce());
      expect(h.publish).toHaveBeenCalledOnce();
      if (retire === "visit") h.visit.abort();
      else h.mounted.unmount();
    } finally {
      await act(async () => {
        release();
        await held;
      });
    }
    expect(h.convertedCallback).not.toHaveBeenCalled();
    expect(h.close).not.toHaveBeenCalled();
    expect(chatConversion(h.session, id)?.converted).toBe(true);
  },
);

it("finishes removal when another details consumer confirmed the uncertain conversion", async () => {
  const h = setup();
  h.publish.mockRejectedValueOnce(new Error("lost acknowledgment"));
  await ready();
  fireEvent.click(confirm());
  await screen.findByRole("alert");
  h.mounted.unmount();
  h.converted();
  await h.session.channelDetails.check(id);
  expect(h.session.channelDetails.snapshot(id)).toBeUndefined();
  expect(chatConversion(h.session, id)?.converted).not.toBe(true);
  render(
    <ConvertToChannel
      session={h.session}
      id={id}
      close={h.close}
      onConverted={h.convertedCallback}
    />,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Finish conversion" }),
  );
  await waitFor(() => expect(h.convertedCallback).toHaveBeenCalledOnce());
  expect(h.publish).toHaveBeenCalledOnce();
  expect(h.unfile).toHaveBeenCalledOnce();
});
it("serializes conversion completion across two mounted forms", async () => {
  const h = setup();
  await ready();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  h.unfile.mockImplementationOnce(async () => {
    await held;
    return { sections: [], assignments: {}, starred: [], muted: [] };
  });
  fireEvent.click(confirm());
  try {
    await waitFor(() => expect(h.unfile).toHaveBeenCalledOnce());
    render(<ConvertToChannel session={h.session} id={id} close={vi.fn()} />);
    const finish = screen.getAllByRole("button", {
      name: "Finish conversion",
      hidden: true,
    });
    expect(finish).toHaveLength(2);
    for (const button of finish) {
      expect(button).toBeDisabled();
      fireEvent.click(button);
    }
    expect(h.publish).toHaveBeenCalledOnce();
    expect(h.unfile).toHaveBeenCalledOnce();
  } finally {
    await act(async () => {
      release();
      await held;
    });
  }
  await waitFor(() => expect(h.convertedCallback).toHaveBeenCalledOnce());
});
