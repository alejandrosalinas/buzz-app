import { expect, it, vi } from "vitest";
import type { RelaySession } from "../relay/session";
import type {
  ChannelDetails,
  ChannelDetailsDraft,
} from "../relay/channel-details-protocol";
import type { DetailsAttempt } from "../relay/channel-details";
import {
  checkShareDestination,
  shareSoloChatAccess,
  soloChatLinkMessage,
} from "./share";

const id = "11111111-1111-4111-8111-111111111111";
const destination = "22222222-2222-4222-8222-222222222222";
const viewer = "a".repeat(64);
function fixture(
  visibility: "public" | "private" = "private",
  joinRole: "member" | "guest" = "member",
) {
  let base: ChannelDetails = {
    channelId: id,
    version: "version",
    name: "Chat",
    description: "Notes",
    visibility,
    joinRole,
    canEdit: true,
    labels: ["buzz.solo", "other"],
    ttlSeconds: 60,
  };
  let attempt: DetailsAttempt | undefined;
  let uncertain = false;
  const load = vi.fn(async () => base);
  const save = vi.fn(
    (
      _base: ChannelDetails,
      draft: ChannelDetailsDraft,
      _signal?: AbortSignal,
      active?: () => boolean,
    ) => {
      const checked = active?.();
      if (checked === false) return Promise.reject(new Error("Cancelled"));
      attempt = { draft, status: "saving" };
      base = { ...base, ...draft, version: "saved" };
      if (uncertain) {
        attempt = { draft, status: "unconfirmed" };
        return Promise.reject(new Error("Check save status"));
      }
      attempt = undefined;
      return Promise.resolve();
    },
  );
  const checkSave = vi.fn(async () => {
    attempt = undefined;
  });
  const channels = [
    { id, channelType: "solo", creator: viewer, members: [viewer] },
    { id: destination, channelType: "stream", members: [viewer] },
  ];
  const refreshRoster = vi.fn(async () => true);
  const session = {
    viewer,
    channels: { list: () => ({ channels }), refreshRoster },
    channelDetails: { load, save, check: checkSave, snapshot: () => attempt },
  } as unknown as RelaySession;
  const attempts = new Map<string, ChannelDetailsDraft>();
  const signal = new AbortController().signal;
  const onAccessChanged = vi.fn();
  return {
    session,
    attempts,
    signal,
    onAccessChanged,
    save,
    load,
    checkSave,
    refreshRoster,
    channels,
    setBase(value: Partial<ChannelDetails>) {
      base = { ...base, ...value };
    },
    uncertain() {
      uncertain = true;
    },
    pending(value: DetailsAttempt) {
      attempt = value;
    },
  };
}

it("requests Private consent, then saves View only with other details preserved", async () => {
  const f = fixture();
  const base = await shareSoloChatAccess(f.session, id, f);
  expect(base?.visibility).toBe("private");
  expect(f.save).not.toHaveBeenCalled();
  expect(f.onAccessChanged).not.toHaveBeenCalled();
  await shareSoloChatAccess(f.session, id, { ...f, confirmed: base });
  expect(f.onAccessChanged).toHaveBeenCalledOnce();
  expect(f.save).toHaveBeenCalledExactlyOnceWith(
    base,
    expect.objectContaining({
      visibility: "public",
      joinRole: "guest",
      name: "Chat",
      description: "Notes",
      ttlSeconds: 60,
      labels: ["buzz.solo", "other"],
    }),
    f.signal,
    expect.any(Function),
  );
});

it("preserves Public policy without consent or writes", async () => {
  const f = fixture("public", "member");
  f.setBase({ canEdit: false });
  expect(await shareSoloChatAccess(f.session, id, f)).toBeUndefined();
  expect(f.save).not.toHaveBeenCalled();
  expect(f.onAccessChanged).not.toHaveBeenCalled();
});

it("requests View only confirmation and retains access without a write", async () => {
  const f = fixture("public", "guest");
  f.setBase({ canEdit: false });
  const base = await shareSoloChatAccess(f.session, id, f);
  expect(base).toMatchObject({ visibility: "public", joinRole: "guest" });
  expect(f.save).not.toHaveBeenCalled();
  expect(
    await shareSoloChatAccess(f.session, id, { ...f, confirmed: base }),
  ).toBeUndefined();
  expect(f.save).not.toHaveBeenCalled();
  expect(f.onAccessChanged).not.toHaveBeenCalled();
});

it("does not claim another client's access change while confirmation is open", async () => {
  const f = fixture();
  const base = await shareSoloChatAccess(f.session, id, f);
  f.setBase({ visibility: "public", joinRole: "guest", version: "other" });
  await shareSoloChatAccess(f.session, id, { ...f, confirmed: base });
  expect(f.save).not.toHaveBeenCalled();
  expect(f.onAccessChanged).not.toHaveBeenCalled();
});

it("does not announce a rejected access save", async () => {
  const f = fixture();
  const base = await shareSoloChatAccess(f.session, id, f);
  f.save.mockRejectedValueOnce(new Error("Settings refused"));
  await expect(
    shareSoloChatAccess(f.session, id, { ...f, confirmed: base }),
  ).rejects.toThrow("Settings refused");
  expect(f.onAccessChanged).not.toHaveBeenCalled();
});

it("does not reopen a View only chat that became Private during confirmation", async () => {
  const f = fixture("public", "guest");
  const base = await shareSoloChatAccess(f.session, id, f);
  f.setBase({ visibility: "private", version: "new-private" });
  await expect(
    shareSoloChatAccess(f.session, id, { ...f, confirmed: base }),
  ).rejects.toThrow("now Private");
  expect(f.save).not.toHaveBeenCalled();
});

it("checks its exact uncertain access attempt without resending it", async () => {
  const f = fixture();
  const base = await shareSoloChatAccess(f.session, id, f);
  f.uncertain();
  await expect(
    shareSoloChatAccess(f.session, id, { ...f, confirmed: base }),
  ).rejects.toThrow("Check save status");
  expect(f.onAccessChanged).not.toHaveBeenCalled();
  await shareSoloChatAccess(f.session, id, { ...f, confirmed: base });
  expect(f.onAccessChanged).toHaveBeenCalledOnce();
  expect(f.checkSave).toHaveBeenCalledExactlyOnceWith(id, f.signal);
  expect(f.save).toHaveBeenCalledOnce();
});

it("does not adopt another surface's uncertain change", async () => {
  const f = fixture();
  const base = await f.load();
  f.pending({ status: "unconfirmed", draft: base });
  await expect(shareSoloChatAccess(f.session, id, f)).rejects.toThrow(
    "Finish the existing",
  );
  expect(f.checkSave).not.toHaveBeenCalled();
  expect(f.save).not.toHaveBeenCalled();
});

it.each(["authority", "owner", "label"])(
  "rejects a Private share after losing %s",
  async (change) => {
    const f = fixture();
    if (change === "authority") f.setBase({ canEdit: false });
    else if (change === "owner") {
      const channel = f.channels[0];
      if (channel) channel.creator = "b".repeat(64);
    } else f.setBase({ labels: [] });
    await expect(shareSoloChatAccess(f.session, id, f)).rejects.toThrow(
      "general access",
    );
    expect(f.save).not.toHaveBeenCalled();
  },
);

it("a changed draft is checked again immediately before dispatch", async () => {
  const f = fixture();
  const base = await shareSoloChatAccess(f.session, id, f);
  let calls = 0;
  await expect(
    shareSoloChatAccess(f.session, id, {
      ...f,
      confirmed: base,
      check: () => {
        if (++calls === 3) throw new Error("Draft changed");
      },
    }),
  ).rejects.toThrow("Draft changed");
});

it("checks destination membership without a recipient limit or grants", async () => {
  const f = fixture();
  const channel = f.channels[1];
  if (!channel) throw new Error("Missing destination");
  channel.members.push(
    ...Array.from({ length: 101 }, (_, n) => n.toString(16).padStart(64, "0")),
  );
  await checkShareDestination(f.session, destination, f.signal);
  expect(f.refreshRoster).toHaveBeenCalledOnce();
  expect(f.save).not.toHaveBeenCalled();
});

it("refuses a destination whose current membership could not be confirmed", async () => {
  const f = fixture();
  f.refreshRoster.mockResolvedValue(false);
  await expect(
    checkShareDestination(f.session, destination, f.signal),
  ).rejects.toThrow("Destination membership");
});

it("escapes a chat name while retaining its ordinary link", () => {
  expect(soloChatLinkMessage(id, "My [chat]\nname")).toBe(
    `[My \\[chat\\] name](buzz://channel/${id})`,
  );
});
