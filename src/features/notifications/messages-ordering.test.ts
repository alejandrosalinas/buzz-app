import { afterEach, expect, it, vi } from "vitest";
import { flush, signed } from "../relay/testing";
import { cleanups, setup } from "./messages-testing";

afterEach(async () => {
  for (const stop of cleanups.splice(0)) await stop();
  vi.restoreAllMocks();
});

it.each([9, 40002])(
  "alerts once when a channel read races ahead of a fresh live kind-%s mention",
  async (kind) => {
    vi.spyOn(Date, "now").mockReturnValue(1_780_000_000_000);
    const h = await setup();
    const mention = signed(h.peer, { ...h.make("Please review this"), kind });
    h.query.mockResolvedValueOnce([mention]);
    await h.owner.session.readRemote([
      { kinds: [kind], "#h": ["room"], limit: 30 },
    ]);
    await flush();
    expect(h.show).not.toHaveBeenCalled();

    h.emit([mention], "live");
    await vi.waitFor(() => expect(h.show).toHaveBeenCalledOnce());
    h.emit([mention], "live");
    await flush();
    expect(h.show).toHaveBeenCalledOnce();
    h.click();
    expect(h.navigation.navigation.snapshot().entry.target).toMatchObject({
      messageId: mention.id,
      channelId: "room",
    });
  },
);
