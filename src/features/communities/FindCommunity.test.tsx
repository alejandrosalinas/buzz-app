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
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { FindCommunity } from "./FindCommunity";
import type { RelayFetch } from "./find-community";

const url = "https://relay.example.com:8443";
const host = "relay.example.com:8443";
const self = "76aa9daa7edc9c2e1dc6a2a90dbce10c1bd52f060fa6506ba7bad4f50240fc01";
const buzz = {
  name: "Buzz Relay",
  software: "https://github.com/block/buzz",
  version: "1.4.2",
  icon: "https://cdn.example.com/icon.png",
  self,
  read_state_snapshot: { community_id: "c1" },
};
const policy = {
  version: "v1",
  terms_markdown: "# Terms",
  privacy_markdown: "# Privacy",
  age_attestation_required: true,
};
afterEach(cleanup);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
/** Answers are read when each request is made, so a test can change them before Retry. */
function relay(answers: () => Record<string, Response | Error>) {
  return vi.fn<RelayFetch>((_origin, path) => {
    const answer = answers()[path];
    if (!answer) throw new Error(`Unexpected path ${path}`);
    return answer instanceof Error
      ? Promise.reject(answer)
      : Promise.resolve(answer);
  });
}
const join = () => screen.getByRole("button", { name: /join/i });
const joinCommunity = () =>
  screen.queryByRole("heading", { name: "Join Community" });
/** Secondary first, primary last, as the design system's footers order them. */
const precedes = (first: HTMLElement, second: HTMLElement) =>
  Boolean(
    first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING,
  );

it("shows the host while finding, then only published facts, gating Join on every consent", async () => {
  const info = deferred<Response>();
  const request = relay(() => ({
    "/": new Response(null, { status: 599 }),
    "/api/join-policy": Response.json({ policy }),
  }));
  request.mockImplementationOnce(() => info.promise);
  const onJoin = vi.fn();
  const user = userEvent.setup();
  render(
    <FindCommunity
      url={url}
      onCancel={vi.fn()}
      onJoin={onJoin}
      request={request}
      titleId="t"
    />,
  );
  expect(
    screen.getByRole("heading", { name: "Finding community" }),
  ).toHaveAttribute("id", "t");
  // An initial read: the host and Cancel show at once, the status waits.
  expect(screen.getByText(host)).toBeVisible();
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
  expect(screen.queryByRole("button", { name: /join/i })).toBeNull();
  await act(async () => info.resolve(Response.json(buzz)));
  expect(joinCommunity()).toBeVisible();
  expect(screen.getByText(host)).toHaveClass("text-body");
  expect(document.querySelector("img")).toHaveAttribute(
    "src",
    "https://cdn.example.com/icon.png",
  );
  // Nothing the relay does not publish: no name, description, counts or version.
  expect(document.body).not.toHaveTextContent(/member|owner|invite|v1\.4/i);
  expect(screen.getByText(url)).toBeVisible();
  const terms = screen.getByRole("link", { name: "Terms of Service" });
  expect(terms).toHaveAttribute("href", `${url}/api/join-policy/terms`);
  expect(terms).toHaveAttribute("target", "_blank");
  expect(screen.getByRole("link", { name: "Privacy Notice" })).toHaveAttribute(
    "href",
    `${url}/api/join-policy/privacy`,
  );
  const age = screen.getByRole("checkbox", {
    name: "I confirm that I am at least 18 years old.",
  });
  const agreement = screen.getByRole("checkbox", {
    name: "I agree to this community’s Terms of Service and Privacy Notice.",
  });
  // Consent gates the button; it never relabels it.
  expect(join()).toHaveTextContent(/^Join$/);
  expect(join()).toBeDisabled();
  expect(precedes(screen.getByRole("button", { name: "Cancel" }), join())).toBe(
    true,
  );
  await user.click(age);
  expect(join()).toBeDisabled();
  await user.click(agreement);
  expect(join()).toBeEnabled();
  await user.click(age);
  expect(join()).toBeDisabled();
  await user.click(age);
  await user.click(join());
  // The consent travels with the community: an invite claim attests the age.
  expect(onJoin).toHaveBeenCalledWith(
    {
      url,
      host,
      name: "Buzz Relay",
      icon: "https://cdn.example.com/icon.png",
      self,
      policy,
    },
    { adult: true, agreed: true },
  );
  // The two unauthenticated reads are the only pre-join traffic: nothing is signed.
  expect(request.mock.calls.map(([origin, path]) => [origin, path])).toEqual([
    [url, "/"],
    [url, "/api/join-policy"],
  ]);
});

it("without a policy Join needs no consent", async () => {
  const request = relay(() => ({
    "/": Response.json({ ...buzz, icon: undefined, version: undefined }),
    "/api/join-policy": new Response("missing", { status: 404 }),
  }));
  render(
    <FindCommunity
      url={url}
      onCancel={vi.fn()}
      onJoin={vi.fn()}
      request={request}
    />,
  );
  expect(
    await screen.findByRole("heading", { name: "Join Community" }),
  ).toBeVisible();
  expect(screen.queryByRole("checkbox")).toBeNull();
  expect(document.querySelector("img")).toBeNull();
  expect(screen.getByRole("button", { name: "Join" })).toBeEnabled();
});

it("with onFound a found community is handed over while the lookup page stays", async () => {
  const request = relay(() => ({
    "/": Response.json(buzz),
    "/api/join-policy": Response.json({ policy }),
  }));
  const onFound = vi.fn();
  const onCancel = vi.fn();
  const user = userEvent.setup();
  render(
    <FindCommunity
      url={url}
      onCancel={onCancel}
      onFound={onFound}
      request={request}
    />,
  );
  await waitFor(() =>
    expect(onFound).toHaveBeenCalledWith({
      url,
      host,
      name: "Buzz Relay",
      icon: "https://cdn.example.com/icon.png",
      self,
      policy,
    }),
  );
  // The caller decides what comes next; nothing here moves on or offers Join.
  expect(
    screen.getByRole("heading", { name: "Finding community" }),
  ).toBeVisible();
  expect(joinCommunity()).toBeNull();
  expect(screen.queryByRole("button", { name: /join/i })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(onCancel).toHaveBeenCalledTimes(1);
  expect(onFound).toHaveBeenCalledTimes(1);
});

it("holds the page while onJoin is pending and leaves a failed join's meaning to the caller", async () => {
  const request = relay(() => ({
    "/": Response.json(buzz),
    "/api/join-policy": new Response("missing", { status: 404 }),
  }));
  const pending = deferred<void>();
  const onJoin = vi
    .fn<(found: unknown) => Promise<void>>()
    .mockReturnValueOnce(pending.promise)
    .mockRejectedValueOnce(new Error("denied"));
  const onCancel = vi.fn();
  const user = userEvent.setup();
  render(
    <FindCommunity
      url={url}
      onCancel={onCancel}
      onJoin={onJoin}
      request={request}
    />,
  );
  await user.click(await screen.findByRole("button", { name: "Join" }));
  expect(screen.getByRole("status")).toHaveTextContent("Joining…");
  expect(join()).toBeDisabled();
  expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(onCancel).not.toHaveBeenCalled();
  await act(async () => pending.resolve());
  expect(screen.queryByRole("status")).toBeNull();
  expect(join()).toBeEnabled();
  expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
  // A rejected join only ends the wait: no copy of its own, no unhandled rejection.
  await user.click(join());
  expect(join()).toBeEnabled();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(joinCommunity()).toBeVisible();
  expect(onJoin).toHaveBeenCalledTimes(2);
});

it("with autoJoin a found community asking no consent joins at once, holding the page without Join Community, and Join Community follows a join that returns", async () => {
  const request = relay(() => ({
    "/": Response.json(buzz),
    "/api/join-policy": new Response("missing", { status: 404 }),
  }));
  const pending = deferred<void>();
  const onJoin = vi
    .fn<(found: unknown, consent: unknown) => Promise<void>>()
    .mockReturnValueOnce(pending.promise);
  const onCancel = vi.fn();
  const user = userEvent.setup();
  render(
    <FindCommunity
      url={url}
      onCancel={onCancel}
      onJoin={onJoin}
      autoJoin
      request={request}
    />,
  );
  await waitFor(() =>
    expect(onJoin).toHaveBeenCalledWith(
      expect.objectContaining({ url, host }),
      { adult: false, agreed: false },
    ),
  );
  expect(
    screen.getByRole("heading", { name: "Joining community" }),
  ).toBeVisible();
  expect(joinCommunity()).toBeNull();
  expect(screen.queryByRole("button", { name: /join/i })).toBeNull();
  expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(onCancel).not.toHaveBeenCalled();
  // A join that returns without the caller moving on can be tried again.
  await act(async () => pending.resolve());
  expect(joinCommunity()).toBeVisible();
  expect(join()).toBeEnabled();
  expect(onJoin).toHaveBeenCalledTimes(1);
});

it("with autoJoin a policy's consent is still asked on Join Community", async () => {
  const request = relay(() => ({
    "/": Response.json(buzz),
    "/api/join-policy": Response.json({ policy }),
  }));
  const onJoin = vi.fn();
  render(
    <FindCommunity
      url={url}
      onCancel={vi.fn()}
      onJoin={onJoin}
      autoJoin
      request={request}
    />,
  );
  expect(
    await screen.findByRole("heading", { name: "Join Community" }),
  ).toBeVisible();
  expect(join()).toBeDisabled();
  expect(onJoin).not.toHaveBeenCalled();
});

it("a community whose consent was given asks nothing on Join Community, and Join attests it", async () => {
  const request = relay(() => ({
    "/": Response.json(buzz),
    "/api/join-policy": Response.json({ policy }),
  }));
  const onJoin = vi.fn();
  const consentGiven = vi.fn(() => true);
  const user = userEvent.setup();
  render(
    <FindCommunity
      url={url}
      onCancel={vi.fn()}
      onJoin={onJoin}
      consentGiven={consentGiven}
      request={request}
    />,
  );
  expect(
    await screen.findByRole("heading", { name: "Join Community" }),
  ).toBeVisible();
  expect(consentGiven).toHaveBeenCalledWith(
    expect.objectContaining({ url, policy }),
  );
  expect(screen.queryByRole("checkbox")).toBeNull();
  await user.click(join());
  expect(onJoin).toHaveBeenCalledWith(expect.objectContaining({ url }), {
    adult: true,
    agreed: true,
  });
});

it("with autoJoin a community whose consent was given joins at once, attesting it", async () => {
  const request = relay(() => ({
    "/": Response.json(buzz),
    "/api/join-policy": Response.json({ policy }),
  }));
  const onJoin = vi.fn(() => new Promise<void>(() => {}));
  render(
    <FindCommunity
      url={url}
      onCancel={vi.fn()}
      onJoin={onJoin}
      autoJoin
      consentGiven={() => true}
      request={request}
    />,
  );
  await waitFor(() =>
    expect(onJoin).toHaveBeenCalledWith(expect.objectContaining({ url }), {
      adult: true,
      agreed: true,
    }),
  );
  expect(
    screen.getByRole("heading", { name: "Joining community" }),
  ).toBeVisible();
  expect(joinCommunity()).toBeNull();
});

it("announces the lookup only after a second, and again a second after Retry", async () => {
  vi.useFakeTimers();
  try {
    let info = deferred<Response>();
    const request = vi.fn<RelayFetch>((_origin, path) =>
      path === "/"
        ? info.promise
        : Promise.resolve(new Response(null, { status: 404 })),
    );
    render(
      <FindCommunity
        url={url}
        onCancel={vi.fn()}
        onJoin={vi.fn()}
        request={request}
      />,
    );
    const region = screen.getByText(host).closest("[aria-busy]");
    expect(region).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(999);
    });
    expect(screen.queryByRole("status")).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(screen.getByRole("status")).toHaveTextContent(`Looking up ${host}…`);
    // Retry is a new initial read: the delay starts again.
    const failed = info;
    info = deferred<Response>();
    await act(async () => failed.resolve(new Response(null, { status: 503 })));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(screen.getByText(host)).toBeVisible();
    expect(screen.queryByRole("status")).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(999);
    });
    expect(screen.queryByRole("status")).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(screen.getByRole("status")).toHaveTextContent(`Looking up ${host}…`);
    await act(async () => info.resolve(Response.json(buzz)));
    expect(joinCommunity()).toBeVisible();
    expect(screen.queryByRole("status")).toBeNull();
    expect(document.querySelector("[aria-busy]")).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

it("Cancel while finding leaves at once and discards the late answer", async () => {
  const info = deferred<Response>();
  let signal: AbortSignal | undefined;
  const request = vi.fn<RelayFetch>((_origin, path, current) => {
    signal = current;
    return path === "/" ? info.promise : Promise.resolve(Response.json({}));
  });
  const onCancel = vi.fn();
  const user = userEvent.setup();
  render(
    <FindCommunity
      url={url}
      onCancel={onCancel}
      onJoin={vi.fn()}
      request={request}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(onCancel).toHaveBeenCalledTimes(1);
  expect(signal?.aborted).toBe(true);
  await act(async () => info.resolve(Response.json(buzz)));
  expect(
    screen.getByRole("heading", { name: "Finding community" }),
  ).toBeVisible();
  expect(screen.queryByRole("button", { name: /join/i })).toBeNull();
});

it("an unreachable relay offers Retry, which looks again", async () => {
  let answers: Record<string, Response | Error> = {
    "/": new TypeError("fetch failed"),
    "/api/join-policy": new TypeError("fetch failed"),
  };
  const request = relay(() => answers);
  const user = userEvent.setup();
  render(
    <FindCommunity
      url={url}
      onCancel={vi.fn()}
      onJoin={vi.fn()}
      request={request}
    />,
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Could not reach the relay. Check your connection and try again.",
  );
  expect(
    screen.getByRole("heading", { name: "Couldn’t find community" }),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
  expect(
    precedes(
      screen.getByRole("button", { name: "Cancel" }),
      screen.getByRole("button", { name: "Retry" }),
    ),
  ).toBe(true);
  answers = {
    "/": Response.json(buzz),
    "/api/join-policy": Response.json({}),
  };
  await user.click(screen.getByRole("button", { name: "Retry" }));
  expect(
    await screen.findByRole("heading", { name: "Join Community" }),
  ).toBeVisible();
  expect(request).toHaveBeenCalledTimes(4);
});

it.each([
  [
    "an HTML page",
    new Response("<html></html>"),
    "This address isn’t a Buzz community.",
  ],
  [
    "a Buzz relay with no community here",
    new Response("relay: no community is configured for this host", {
      status: 404,
    }),
    "No community is set up at this address.",
  ],
])("%s offers only Cancel", async (_label, answer, message) => {
  const request = relay(() => ({
    "/": answer,
    "/api/join-policy": Response.json({}),
  }));
  const onCancel = vi.fn();
  const user = userEvent.setup();
  render(
    <FindCommunity
      url={url}
      onCancel={onCancel}
      onJoin={vi.fn()}
      request={request}
    />,
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(message);
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(onCancel).toHaveBeenCalledTimes(1);
});
