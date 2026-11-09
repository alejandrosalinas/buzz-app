// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, expect, it } from "vitest";
import type { ChannelMessage } from "../relay/contracts";
import type { RelaySession } from "../relay/session";
import { selectNewestMessage } from "./message-selection";
import { useMessageSelection } from "./use-message-selection";

afterEach(cleanup);

const message = (id: string, createdAt: number, createdAtMs?: number) =>
  ({ id, createdAt, createdAtMs }) as ChannelMessage;

function List({ rows }: { rows: readonly ChannelMessage[] }) {
  const list = useRef<HTMLElement>(null);
  useMessageSelection(list, rows, {} as RelaySession);
  return (
    <section ref={list} aria-label="Messages">
      {rows.map((row) => (
        <div key={row.id} data-message-id={row.id}>
          <div data-layout="timeline">{row.id}</div>
        </div>
      ))}
    </section>
  );
}

function newestSelected(rows: readonly ChannelMessage[]) {
  const { getByRole } = render(<List rows={rows} />, { reactStrictMode: true });
  expect(selectNewestMessage(getByRole("region", { name: "Messages" }))).toBe(
    true,
  );
  return document.activeElement?.closest<HTMLElement>("[data-message-id]")
    ?.dataset.messageId;
}

it("selects the latest message of a same-second burst by send ms, then id", () => {
  expect(
    newestSelected([message("z", 100, 100_100), message("a", 100, 100_200)]),
  ).toBe("a");
  cleanup();
  expect(newestSelected([message("a", 100), message("b", 100)])).toBe("b");
});

it("selects the latest message across seconds and skips membership notices", () => {
  const notice = {
    ...message("notice", 300),
    membership: {},
  } as ChannelMessage;
  expect(
    newestSelected([message("old", 100), message("new", 200), notice]),
  ).toBe("new");
});
