// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RelaySession } from "../relay/session";
import { ForwardedMessage } from "./ForwardedMessage";
import { useForwardSource } from "./use-forward-source";

function Reader({ session, id }: { session: RelaySession; id: string }) {
  const source = useForwardSource(session, "source", id);
  return (
    <span>
      {source.row
        ? `Ready ${id}`
        : source.unavailable
          ? "Unavailable"
          : "Loading"}
    </span>
  );
}
afterEach(cleanup);
it("bounds simultaneous card source checks and releases readers after completion", async () => {
  let active = 0;
  let maximum = 0;
  const pending: (() => void)[] = [];
  const thread = vi.fn((_channel: string, id: string) => {
    maximum = Math.max(maximum, ++active);
    let ready = false;
    let notify = () => {};
    pending.push(() => {
      ready = true;
      notify();
    });
    return {
      snapshot: () => ({
        status: ready ? "ready" : "loading",
        targetStatus: ready ? "ready" : "loading",
        target: ready ? { id } : undefined,
        replies: [],
        canLoadMore: false,
      }),
      subscribe: (listener: () => void) => {
        notify = listener;
        return () => {
          notify = () => {};
        };
      },
      refresh: async () => {},
      dispose: vi.fn(() => active--),
    };
  });
  const session = {
    thread,
    channels: {
      list: () => ({ status: "ready" }),
      subscribeList: () => () => {},
      describe: () => ({ state: "found", name: "Source", readable: true }),
    },
  } as unknown as RelaySession;
  const view = render(
    <>
      {Array.from({ length: 70 }, (_, index) => String(index)).map((id) => (
        <Reader key={id} id={id} session={session} />
      ))}
    </>,
  );
  await waitFor(() => expect(thread).toHaveBeenCalledTimes(4));
  expect(active).toBe(4);
  while (screen.queryAllByText(/^Ready /).length < 70) {
    await act(async () => {
      pending.splice(0).forEach((finish) => {
        finish();
      });
    });
  }
  expect(maximum).toBe(4);
  expect(active).toBe(0);
  view.unmount();
  expect(active).toBe(0);
});
it("renders without requesting a private source the viewer cannot read", async () => {
  const thread = vi.fn();
  const session = {
    thread,
    channels: {
      list: () => ({ status: "ready" }),
      subscribeList: () => () => {},
      describe: () => ({ state: "withheld" }),
    },
  } as unknown as RelaySession;
  await act(async () => {
    render(<Reader session={session} id="source-message" />);
  });
  expect(thread).not.toHaveBeenCalled();
});

it("keeps an unreadable public source loading until lookup settles", async () => {
  let looking = true;
  let notify = () => {};
  const thread = vi.fn();
  const session = {
    thread,
    channels: {
      list: () => ({ status: "ready" }),
      subscribeList: (listener: () => void) => {
        notify = listener;
        return () => {};
      },
      describe: () => ({
        state: "found",
        name: "Source",
        readable: false,
        ...(looking ? { looking: true } : { answered: true }),
      }),
    },
  } as unknown as RelaySession;
  await act(async () => {
    render(<Reader session={session} id="message" />);
  });
  expect(screen.getByText("Loading")).toBeTruthy();
  expect(thread).not.toHaveBeenCalled();
  await act(async () => {
    looking = false;
    notify();
  });
  expect(screen.getByText("Unavailable")).toBeTruthy();
  expect(thread).not.toHaveBeenCalled();
});

it.each([true, false])(
  "shows unavailable card copy only after unreadable lookup settles (looking=%s)",
  async (looking) => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    const thread = vi.fn();
    const session = {
      thread,
      profiles: { snapshot: () => new Map(), subscribe: () => () => {} },
      channels: {
        list: () => ({ status: "ready" }),
        subscribeList: () => () => {},
        describe: () => ({
          state: "found",
          name: "Source",
          readable: false,
          ...(looking ? { looking: true } : { answered: true }),
        }),
      },
    } as unknown as RelaySession;
    try {
      await act(async () => {
        render(
          <ForwardedMessage
            session={session}
            snapshot={{
              id: "message",
              channelId: "source",
              authorId: "author",
              authorName: "Author",
              createdAt: 1,
              content: "Copied text",
            }}
            onOpenLink={vi.fn()}
          >
            Copied text
          </ForwardedMessage>,
        );
      });
      expect(Boolean(screen.queryByText("Original unavailable"))).toBe(
        !looking,
      );
      expect(screen.getByText("Copied text")).toBeTruthy();
      expect(screen.getByText("Private conversation")).toBeTruthy();
      expect(screen.queryByText("View original")).toBeNull();
      expect(thread).not.toHaveBeenCalled();
    } finally {
      cleanup();
      vi.unstubAllGlobals();
    }
  },
);
