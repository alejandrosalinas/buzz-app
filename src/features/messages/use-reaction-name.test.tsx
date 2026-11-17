// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { flush } from "../relay/testing";
import { useReactionName } from "./use-reaction-name";

afterEach(cleanup);

function Name({ content }: { content: string }) {
  const name = useReactionName();
  return <span>{name ? name(content) : "unresolved"}</span>;
}

it("leaves the name unresolved when the table fails to load, and the next mount retries", async () => {
  // A navigation cancels the chunk in flight, so the import rejects.
  vi.doMock("./reaction-name", () =>
    Promise.reject(new TypeError("Importing a module script failed.")),
  );
  const unhandled = vi.fn();
  process.on("unhandledRejection", unhandled);
  const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const first = render(<Name content="🏠" />);
    // The mocked import rejects after one tick or several; wait for its handler.
    await waitFor(() =>
      expect(warned).toHaveBeenCalledWith(
        "The reaction name table didn't load",
        expect.any(Error),
      ),
    );
    await act(flush);
    expect(screen.getByText("unresolved")).toBeTruthy();
    expect(unhandled).not.toHaveBeenCalled();
    first.unmount();
    vi.doUnmock("./reaction-name");
    render(<Name content="🏠" />);
    expect(await screen.findByText(":house:")).toBeTruthy();
  } finally {
    vi.doUnmock("./reaction-name");
    process.off("unhandledRejection", unhandled);
    warned.mockRestore();
  }
});
