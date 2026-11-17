// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RelaySession } from "../relay/session";
import { useForwardSource } from "./use-forward-source";

function Reader({ session, id }: { session: RelaySession; id: string }) {
  const source = useForwardSource(session, "source", id);
  return <span>{source.row ? `Ready ${id}` : "Loading"}</span>;
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
