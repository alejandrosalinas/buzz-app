// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createAgentChoices } from "../agents/choices";
import { createAgentLibrary } from "../agents/library";
import type { RelaySession } from "../relay/session";
import { readView } from "../../shared/view-state";
import {
  clearDefaultAgent,
  clearDeletedDefaultAgent,
  chooseDefaultAgent,
  defaultAgentControl,
  forgetDefaultAgent,
  restoreDefaultAgent,
  savedAgentStore,
  setDefaultAgent,
  useDefaultAgent,
  useSavedAgentState,
} from "./default-agent";

afterEach(() => {
  cleanup();
  localStorage.clear();
});
it("choosing a default updates new-chat routing only in its account/community scope", () => {
  const choices = {
    status: "ready",
    complete: true,
    selectable: [
      { pubkey: "a".repeat(64), name: "First", managed: true },
      { pubkey: "b".repeat(64), name: "Second", managed: true },
    ],
    archives: { status: "unavailable", archived: [] },
  };
  const session = {
    agentChoices: {
      snapshot: () => choices,
      subscribe: () => () => {},
      retain: () => () => {},
      ensure: () => {},
    },
  } as unknown as RelaySession;
  function Selection({ scope }: { scope: string }) {
    return (
      <output aria-label={scope}>
        {useDefaultAgent(session, scope)?.name}
      </output>
    );
  }
  render(
    <>
      <Selection scope="one" />
      <Selection scope="two" />
    </>,
  );
  expect(screen.getByLabelText("one").textContent).toBe("First");
  act(() => {
    setDefaultAgent("one", "b".repeat(64));
  });
  expect(screen.getByLabelText("one").textContent).toBe("Second");
  expect(screen.getByLabelText("two").textContent).toBe("First");
  act(() => {
    setDefaultAgent("one", "d".repeat(64));
  });
  expect(screen.getByLabelText("one").textContent).toBe("First");
});

it("waits for complete fallback and settled archive evidence, but honors an available explicit choice", () => {
  const relay = { pubkey: "a".repeat(64), name: "Relay", managed: false };
  const local = { pubkey: "b".repeat(64), name: "Local", managed: true };
  let choices = {
    status: "ready",
    complete: false,
    pending: true,
    selectable: [relay],
    archives: { status: "loading", archived: [] },
  };
  const listeners = new Set<() => void>();
  const session = {
    agentChoices: {
      snapshot: () => choices,
      subscribe: (notify: () => void) => {
        listeners.add(notify);
        return () => listeners.delete(notify);
      },
      retain: () => () => {},
      ensure: () => {},
    },
  } as unknown as RelaySession;
  function Selection() {
    return (
      <output aria-label="choice">
        {useDefaultAgent(session, "loading")?.name}
      </output>
    );
  }
  render(<Selection />);
  expect(screen.getByLabelText("choice")).toBeEmptyDOMElement();
  act(() => {
    setDefaultAgent("loading", relay.pubkey);
  });
  expect(screen.getByLabelText("choice")).toHaveTextContent("Relay");
  act(() => {
    setDefaultAgent("loading", "d".repeat(64));
    choices = {
      ...choices,
      complete: true,
      pending: false,
      selectable: [relay, local],
    };
    for (const notify of listeners) notify();
  });
  expect(screen.getByLabelText("choice")).toBeEmptyDOMElement();
  act(() => {
    choices = { ...choices, archives: { status: "ready", archived: [] } };
    for (const notify of listeners) notify();
  });
  expect(screen.getByLabelText("choice")).toHaveTextContent("Local");
});

it("a requested agent replaces the default, and nothing stands in for it", () => {
  const choices = {
    status: "ready",
    complete: true,
    selectable: [
      { pubkey: "a".repeat(64), name: "First", managed: true },
      { pubkey: "b".repeat(64), name: "Second", managed: true },
    ],
    archives: { status: "unavailable", archived: [] },
  };
  const session = {
    agentChoices: {
      snapshot: () => choices,
      subscribe: () => () => {},
      retain: () => () => {},
      ensure: () => {},
    },
  } as unknown as RelaySession;
  function Selection({ requested }: { requested: string }) {
    return (
      <output aria-label={requested.slice(0, 1)}>
        {useDefaultAgent(session, "requested", requested)?.name ?? "none"}
      </output>
    );
  }
  render(
    <>
      <Selection requested={"b".repeat(64)} />
      <Selection requested={"d".repeat(64)} />
    </>,
  );
  expect(screen.getByLabelText("b").textContent).toBe("Second");
  expect(screen.getByLabelText("d").textContent).toBe("none");
});

it("keeps the main agent stable: saves the first pick and replaces only a deleted choice", () => {
  const first = { pubkey: "a".repeat(64), name: "First", managed: true };
  const second = { pubkey: "b".repeat(64), name: "Second", managed: true };
  let choices = {
    status: "ready",
    complete: true,
    selectable: [first, second],
    archives: { status: "ready", archived: [] as string[] },
  };
  const listeners = new Set<() => void>();
  const update = (next: Partial<typeof choices>) => {
    choices = { ...choices, ...next };
    for (const notify of listeners) notify();
  };
  const session = {
    agentChoices: {
      snapshot: () => choices,
      subscribe: (notify: () => void) => {
        listeners.add(notify);
        return () => listeners.delete(notify);
      },
      retain: () => () => {},
      ensure: () => {},
    },
  } as unknown as RelaySession;
  function Selection() {
    return (
      <output aria-label="main">
        {useDefaultAgent(session, "stable")?.name}
      </output>
    );
  }
  render(<Selection />);
  // The automatic pick is saved, so a different load order doesn't move it.
  expect(screen.getByLabelText("main")).toHaveTextContent("First");
  act(() => update({ selectable: [second, first] }));
  expect(screen.getByLabelText("main")).toHaveTextContent("First");
  // A chosen agent missing for a while is stood in for, then comes back.
  act(() => {
    setDefaultAgent("stable", second.pubkey);
  });
  act(() => update({ selectable: [first] }));
  expect(screen.getByLabelText("main")).toHaveTextContent("First");
  act(() => update({ selectable: [first, second] }));
  expect(screen.getByLabelText("main")).toHaveTextContent("Second");
  // Deleting it hands the role on for good.
  act(() =>
    update({
      selectable: [first],
      archives: { status: "ready", archived: [second.pubkey] },
    }),
  );
  expect(screen.getByLabelText("main")).toHaveTextContent("First");
  act(() =>
    update({
      selectable: [second, first],
      archives: { status: "ready", archived: [] },
    }),
  );
  expect(screen.getByLabelText("main")).toHaveTextContent("First");
});

it("a deleted main agent hands the role on for good, even without archive evidence", () => {
  const [a, b, c] = ["a", "b", "c"].map((letter) => ({
    pubkey: letter.repeat(64),
    name: letter.toUpperCase(),
    managed: true,
  }));
  let choices = {
    status: "ready",
    complete: true,
    selectable: [a, b, c],
    archives: { status: "unavailable", archived: [] as string[] },
  };
  const listeners = new Set<() => void>();
  const update = (selectable: typeof choices.selectable) => {
    choices = { ...choices, selectable };
    for (const notify of listeners) notify();
  };
  const session = {
    agentChoices: {
      snapshot: () => choices,
      subscribe: (notify: () => void) => {
        listeners.add(notify);
        return () => listeners.delete(notify);
      },
      retain: () => () => {},
      ensure: () => {},
    },
  } as unknown as RelaySession;
  function Selection({ scope }: { scope: string }) {
    return (
      <output aria-label={scope}>
        {useDefaultAgent(session, scope)?.name}
      </output>
    );
  }
  render(
    <>
      <Selection scope="one" />
      <Selection scope="two" />
    </>,
  );
  act(() => {
    setDefaultAgent("one", b?.pubkey ?? "");
    setDefaultAgent("two", c?.pubkey ?? "");
  });
  act(() => {
    update([a, c].filter((agent) => agent !== undefined));
    forgetDefaultAgent(b?.pubkey ?? "");
  });
  expect(screen.getByLabelText("one")).toHaveTextContent("A");
  // Another scope's choice is untouched.
  expect(screen.getByLabelText("two")).toHaveTextContent("C");
  act(() => update([c, a].filter((agent) => agent !== undefined)));
  expect(screen.getByLabelText("one")).toHaveTextContent("A");
});

it("after a finished delete, rereads cached inventory before choosing a replacement", async () => {
  const a = { pubkey: "a".repeat(64), name: "A" };
  const b = { pubkey: "b".repeat(64), name: "B" };
  let rows = [b, a];
  const library = createAgentLibrary(async () => ({
    definitions: [],
    identities: rows,
  }));
  const agentChoices = createAgentChoices({
    scope: `https://relay.example.test:${"f".repeat(64)}`,
    library: library.queries,
    signal: new AbortController().signal,
  });
  await library.queries.refresh();
  const session = {
    agentChoices,
  } as unknown as RelaySession;
  function Selection() {
    return (
      <output aria-label="main">
        {useDefaultAgent(session, "reread")?.name}
      </output>
    );
  }
  render(<Selection />);
  act(() => {
    setDefaultAgent("reread", b.pubkey);
  });
  expect(screen.getByLabelText("main")).toHaveTextContent("B");
  // B's record is deleted; the cached library still lists it until reread.
  rows = [a];
  await act(async () => {
    await agentChoices.refresh();
    forgetDefaultAgent(b.pubkey);
  });
  expect(screen.getByLabelText("main")).toHaveTextContent("A");
  rows = [{ pubkey: "c".repeat(64), name: "C" }, a];
  await act(() => agentChoices.refresh());
  expect(screen.getByLabelText("main")).toHaveTextContent("A");
});

it("a read begun before the delete can't bring the deleted main agent back", async () => {
  const a = { pubkey: "a".repeat(64), name: "A" };
  const b = { pubkey: "b".repeat(64), name: "B" };
  let rows = [b, a];
  let release: (() => void) | undefined;
  let hold = false;
  const library = createAgentLibrary(async () => {
    const captured = rows;
    if (hold) await new Promise<void>((resolve) => (release = resolve));
    return { definitions: [], identities: captured };
  });
  const agentChoices = createAgentChoices({
    scope: `https://relay.example.test:${"f".repeat(64)}`,
    library: library.queries,
    signal: new AbortController().signal,
  });
  await library.queries.refresh();
  const session = {
    agentChoices,
  } as unknown as RelaySession;
  function Selection() {
    return (
      <output aria-label="main">
        {useDefaultAgent(session, "held")?.name}
      </output>
    );
  }
  render(<Selection />);
  act(() => {
    setDefaultAgent("held", b.pubkey);
  });
  // A read that captured B is still in flight when B is deleted.
  hold = true;
  const stale = library.queries.refresh();
  await act(async () => {});
  hold = false;
  rows = [a];
  await act(async () => {
    await agentChoices.refresh(true, { fresh: true });
    forgetDefaultAgent(b.pubkey);
  });
  await act(async () => {
    release?.();
    await stale;
  });
  expect(screen.getByLabelText("main")).toHaveTextContent("A");
  rows = [{ pubkey: "c".repeat(64), name: "C" }, a];
  await act(() => agentChoices.refresh());
  expect(screen.getByLabelText("main")).toHaveTextContent("A");
});

function accountSession(
  saved: string | null | undefined,
  archived: string[] = [],
  archives = "ready",
) {
  const first = { pubkey: "a".repeat(64), name: "First", managed: true };
  const second = { pubkey: "b".repeat(64), name: "Second", managed: true };
  const listeners = new Set<() => void>();
  const evidence = (archived: string[], status: string, readAt?: number) => ({
    status: "ready",
    complete: true,
    selectable: [first, second].filter(
      ({ pubkey }) => !archived.includes(pubkey),
    ),
    archives: { status, archived, readAt },
  });
  let choices = evidence(
    archived,
    archives,
    archives === "ready" ? 1 : undefined,
  );
  let read!: () => void;
  const account = {
    // Resolves with the record as it was when the read began.
    read: vi.fn(() => {
      const record = saved;
      return new Promise<string | null | undefined>((resolve) => {
        read = () => resolve(record);
      });
    }),
    // None reads back as a saved none, as the account's reader does.
    write: vi.fn(async (agent: string | null) => {
      saved = agent;
    }),
    saved: () => saved,
    resolve: () => read(),
    /** The archive read settles with these agents archived; a reread or a
     * failed one keeps the last known ones, as the session's archives do. */
    archive: (deleted: string[], status = "ready") => {
      const { archived, readAt } = choices.archives;
      choices =
        status === "ready"
          ? evidence(deleted, status, 1)
          : evidence(archived, status, readAt);
      for (const listener of listeners) listener();
    },
  };
  const session = {
    mainAgent: account,
    agentChoices: {
      snapshot: () => choices,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
      retain: () => () => {},
      ensure: () => {},
    },
  } as unknown as RelaySession;
  function Selection() {
    return (
      <output>{useDefaultAgent(session, "account")?.name ?? "none"}</output>
    );
  }
  return { account, session, Selection };
}

it("adopts the account's main agent before any automatic pick on a new install", async () => {
  const { account, Selection } = accountSession("b".repeat(64));
  render(<Selection />);
  expect(screen.getByRole("status").textContent).toBe("none");
  await act(async () => account.resolve());
  expect(screen.getByRole("status").textContent).toBe("Second");
  expect(account.write).not.toHaveBeenCalled();
});

it("a choice cached on this device waits for the account's, which replaces it", async () => {
  const { account, Selection } = accountSession("b".repeat(64));
  setDefaultAgent("account", "a".repeat(64));
  render(<Selection />);
  expect(screen.getByRole("status").textContent).toBe("none");
  await act(async () => account.resolve());
  expect(screen.getByRole("status").textContent).toBe("Second");
});

it("keeps automatic picks on the device and saves explicit choices to the account", async () => {
  const { account, session, Selection } = accountSession(undefined);
  render(<Selection />);
  await act(async () => account.resolve());
  expect(screen.getByRole("status").textContent).toBe("First");
  expect(account.write).not.toHaveBeenCalled();
  await act(() => chooseDefaultAgent(session, "account", "b".repeat(64)));
  expect(screen.getByRole("status").textContent).toBe("Second");
  expect(account.saved()).toBe("b".repeat(64));
});

it("saves no Bestie to the account and restores the device choice when that save fails", async () => {
  const scope = "clear-account";
  const pubkey = "b".repeat(64);
  setDefaultAgent(scope, pubkey);
  const write = vi.fn(async (_agent: string | null) => {
    throw new Error("offline");
  });
  const session = {
    mainAgent: { read: async () => pubkey, write },
  } as unknown as RelaySession;
  await expect(clearDefaultAgent(session, scope)).rejects.toThrow(
    "Removing your Bestie couldn't be saved to your account. Try again.",
  );
  expect(write).toHaveBeenCalledWith(null);
  expect(readView(scope, "solo:default-agent", null)).toBe(pubkey);
});

it("clears a deleted agent only when it is still the account's Bestie", async () => {
  const scope = "delete-account";
  const deleted = "b".repeat(64);
  const other = "a".repeat(64);
  let saved: string | undefined = other;
  const write = vi.fn(async (agent: string | null) => {
    saved = agent ?? undefined;
  });
  const clear = vi.fn(async (expected: string) => {
    if (saved === expected) saved = undefined;
    return saved;
  });
  const session = {
    mainAgent: { read: async () => saved, write, clear },
  } as unknown as RelaySession;
  expect(await clearDeletedDefaultAgent(session, scope, deleted)).toBe(false);
  expect(write).not.toHaveBeenCalled();
  expect(clear).toHaveBeenCalledWith(deleted);
  expect(readView(scope, "solo:default-agent", null)).toBe(other);
  saved = deleted;
  setDefaultAgent(scope, deleted);
  expect(await clearDeletedDefaultAgent(session, scope, deleted)).toBe(true);
  expect(clear).toHaveBeenCalledWith(deleted);
  expect(write).not.toHaveBeenCalled();
  expect(saved).toBeUndefined();
});

it("restores an abandoned replacement without overwriting a newer choice", () => {
  const first = "a".repeat(64);
  const failed = "b".repeat(64);
  const newer = "c".repeat(64);
  setDefaultAgent("restore", failed);
  expect(restoreDefaultAgent("restore", failed, first)).toBe(true);
  setDefaultAgent("restore", newer);
  expect(restoreDefaultAgent("restore", failed, first)).toBe(false);
  expect(readView("restore", "solo:default-agent", null)).toBe(newer);
});

it("stands in for a deleted agent left on the account without writing to it", async () => {
  const { account, session, Selection } = accountSession("b".repeat(64), [
    "b".repeat(64),
  ]);
  render(<Selection />);
  await act(async () => account.resolve());
  expect(screen.getByRole("status").textContent).toBe("First");
  expect(account.write).not.toHaveBeenCalled();
  // Only the next choice replaces it.
  await act(() => chooseDefaultAgent(session, "account", "a".repeat(64)));
  expect(account.saved()).toBe("a".repeat(64));
});

it("an adopted choice waits for archives, which may show it deleted", async () => {
  // The account still names B, deleted elsewhere; archives aren't read yet.
  const { account, Selection } = accountSession("b".repeat(64), [], "loading");
  setDefaultAgent("account", "a".repeat(64));
  render(<Selection />);
  await act(async () => account.resolve());
  expect(screen.getByRole("status").textContent).toBe("none");
  act(() => account.archive(["b".repeat(64)]));
  expect(screen.getByRole("status").textContent).toBe("First");
});

it("keeps an adopted or chosen main agent through later archive reads", async () => {
  const { account, session, Selection } = accountSession("b".repeat(64));
  render(<Selection />);
  await act(async () => account.resolve());
  expect(screen.getByRole("status").textContent).toBe("Second");
  act(() => account.archive([], "loading"));
  expect(screen.getByRole("status").textContent).toBe("Second");
  act(() => account.archive([]));
  await act(() => chooseDefaultAgent(session, "account", "a".repeat(64)));
  act(() => account.archive([], "loading"));
  expect(screen.getByRole("status").textContent).toBe("First");
});

it("remembers the first archive evidence while no composer is shown", async () => {
  const { account, Selection } = accountSession("b".repeat(64), [], "loading");
  const { unmount } = render(<Selection />);
  await act(async () => account.resolve());
  unmount();
  act(() => account.archive([]));
  act(() => account.archive([], "loading"));
  render(<Selection />);
  expect(screen.getByRole("status").textContent).toBe("Second");
});

it("a choice adopted while archives are reread stays out once known deleted", async () => {
  const { account, Selection } = accountSession("b".repeat(64), [], "loading");
  render(<Selection />);
  act(() => account.archive(["b".repeat(64)]));
  act(() => account.archive([], "loading"));
  await act(async () => account.resolve());
  expect(screen.getByRole("status").textContent).toBe("First");
});

it("rechecks a choice adopted when a failed account read is retried", async () => {
  const { account, Selection } = accountSession("b".repeat(64), [], "loading");
  account.read.mockRejectedValueOnce(new Error("offline"));
  setDefaultAgent("account", "a".repeat(64));
  const { unmount } = render(<Selection />);
  await act(async () => {});
  act(() => account.archive(["b".repeat(64)]));
  expect(screen.getByRole("status").textContent).toBe("First");
  unmount();
  act(() => account.archive([], "loading"));
  render(<Selection />);
  await act(async () => account.resolve());
  expect(screen.getByRole("status").textContent).toBe("First");
});

it("forgets a deleted adopted choice even when no composer sees the archives settle", async () => {
  const { account, Selection } = accountSession("b".repeat(64), [], "loading");
  const { unmount } = render(<Selection />);
  await act(async () => account.resolve());
  unmount();
  act(() => account.archive(["b".repeat(64)]));
  // Neither a failed reread nor a reconnect's forgets the deletion.
  act(() => account.archive([], "error"));
  act(() => account.archive([], "idle"));
  render(<Selection />);
  expect(screen.getByRole("status").textContent).toBe("First");
});

it("keeps the main agent through a reconnect and a failed reread", async () => {
  const { account, Selection } = accountSession("b".repeat(64));
  render(<Selection />);
  await act(async () => account.resolve());
  act(() => account.archive([], "idle"));
  expect(screen.getByRole("status").textContent).toBe("Second");
  act(() => account.archive([], "error"));
  expect(screen.getByRole("status").textContent).toBe("Second");
});

it("keeps a live choice adopted on retry through later archive reads", async () => {
  const { account, Selection } = accountSession("b".repeat(64), [], "loading");
  account.read.mockRejectedValueOnce(new Error("offline"));
  const { unmount } = render(<Selection />);
  await act(async () => {});
  act(() => account.archive([]));
  unmount();
  act(() => account.archive([], "loading"));
  render(<Selection />);
  await act(async () => account.resolve());
  act(() => account.archive([]));
  expect(screen.getByRole("status").textContent).toBe("Second");
  act(() => account.archive([], "loading"));
  expect(screen.getByRole("status").textContent).toBe("Second");
});

it("ignores an older read failure after a newer choice and preserves it through retry", async () => {
  const pending = () => {
    let resolve!: (value: string | undefined) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<string | undefined>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    return { promise, resolve, reject };
  };
  const first = pending();
  const second = pending();
  let reads = 0;
  const account = {
    read: vi.fn(() => (reads++ ? second.promise : first.promise)),
    write: vi.fn(async () => {}),
  };
  const session = { mainAgent: account } as unknown as RelaySession;
  function Selection() {
    const state = useSavedAgentState(session, "stale-failure");
    return (
      <>
        <output aria-label="agent">{state.agent ?? "none"}</output>
        <output aria-label="error">{state.error ?? "none"}</output>
        <button type="button" onClick={state.retry}>
          Retry
        </button>
      </>
    );
  }
  render(<Selection />);
  await act(() => chooseDefaultAgent(session, "stale-failure", "a".repeat(64)));
  await act(async () => first.reject(new Error("old read failed")));
  account.write.mockRejectedValueOnce(new Error("replacement failed"));
  await act(async () => {
    await expect(
      chooseDefaultAgent(session, "stale-failure", "b".repeat(64)),
    ).rejects.toThrow("couldn't be saved");
  });
  expect(screen.getByLabelText("agent")).toHaveTextContent("a".repeat(64));
  expect(screen.getByLabelText("error")).toHaveTextContent("none");
  await act(async () => screen.getByRole("button", { name: "Retry" }).click());
  await act(async () => second.resolve("a".repeat(64)));
  expect(screen.getByLabelText("agent")).toHaveTextContent("a".repeat(64));
  expect(screen.getByLabelText("error")).toHaveTextContent("none");
});

it.each(["a".repeat(64), undefined])(
  "keeps the last confirmed Bestie after a rejected replacement (initial %s)",
  async (initial) => {
    const { account, session } = accountSession(initial);
    function Selection() {
      const state = useSavedAgentState(session, "account");
      return (
        <>
          <output aria-label="read">{String(state.read)}</output>
          <output aria-label="agent">{state.agent ?? "none"}</output>
          <output aria-label="error">{state.error ?? "none"}</output>
        </>
      );
    }
    const view = render(<Selection />);
    await act(async () => account.resolve());
    await act(() => chooseDefaultAgent(session, "account", "b".repeat(64)));
    account.write.mockRejectedValueOnce(new Error("offline"));
    await act(async () => {
      await expect(
        chooseDefaultAgent(session, "account", "c".repeat(64)),
      ).rejects.toThrow("couldn't be saved");
    });
    expect(account.saved()).toBe("b".repeat(64));
    expect(screen.getByLabelText("read")).toHaveTextContent("true");
    expect(screen.getByLabelText("agent")).toHaveTextContent("b".repeat(64));
    expect(screen.getByLabelText("error")).toHaveTextContent("none");
    view.unmount();
    render(<Selection />);
    expect(screen.getByLabelText("agent")).toHaveTextContent("b".repeat(64));
  },
);

it("settles a first account read after its attempted choice fails", async () => {
  let resolve!: (value: string | undefined) => void;
  const read = new Promise<string | undefined>((done) => {
    resolve = done;
  });
  const account = {
    read: vi.fn(() => read),
    write: vi.fn(async () => {
      throw new Error("write failed");
    }),
  };
  const session = { mainAgent: account } as unknown as RelaySession;
  function Selection() {
    const state = useSavedAgentState(session, "failed-first-choice");
    return (
      <>
        <output aria-label="read">{String(state.read)}</output>
        <output aria-label="agent">{state.agent ?? "none"}</output>
        <output aria-label="error">{state.error ?? "none"}</output>
      </>
    );
  }
  const view = render(<Selection />);
  await act(async () => {});
  await expect(
    chooseDefaultAgent(session, "failed-first-choice", "a".repeat(64)),
  ).rejects.toThrow(
    "Your bestie couldn't be saved to your account. Try again.",
  );
  await act(async () => resolve("b".repeat(64)));
  expect(screen.getByLabelText("read")).toHaveTextContent("true");
  expect(screen.getByLabelText("agent")).toHaveTextContent("b".repeat(64));
  expect(screen.getByLabelText("error")).toHaveTextContent("none");
  view.unmount();
  render(<Selection />);
  expect(screen.getByLabelText("read")).toHaveTextContent("true");
  expect(screen.getByLabelText("agent")).toHaveTextContent("b".repeat(64));
});

it("recovers a failed first account read after its attempted choice fails", async () => {
  const pending = () => {
    let resolve!: (value: string | undefined) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<string | undefined>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    return { promise, resolve, reject };
  };
  const first = pending();
  const second = pending();
  let reads = 0;
  const account = {
    read: vi.fn(() => (reads++ ? second.promise : first.promise)),
    write: vi.fn(async () => {
      throw new Error("write failed");
    }),
  };
  const session = { mainAgent: account } as unknown as RelaySession;
  function Selection() {
    const state = useSavedAgentState(session, "failed-first-read");
    return (
      <>
        <output aria-label="read">{String(state.read)}</output>
        <output aria-label="agent">{state.agent ?? "none"}</output>
        <output aria-label="error">{state.error ?? "none"}</output>
      </>
    );
  }
  const view = render(<Selection />);
  await act(async () => {});
  await expect(
    chooseDefaultAgent(session, "failed-first-read", "a".repeat(64)),
  ).rejects.toThrow(
    "Your bestie couldn't be saved to your account. Try again.",
  );
  await act(async () => first.reject(new Error("account offline")));
  expect(screen.getByLabelText("read")).toHaveTextContent("true");
  expect(screen.getByLabelText("error")).toHaveTextContent("account offline");
  view.unmount();
  render(<Selection />);
  await act(async () => second.resolve("b".repeat(64)));
  expect(screen.getByLabelText("read")).toHaveTextContent("true");
  expect(screen.getByLabelText("agent")).toHaveTextContent("b".repeat(64));
  expect(screen.getByLabelText("error")).toHaveTextContent("none");
});

it.each([false, true])(
  "settles the initial account outcome received before its first write rejects (read fails: %s)",
  async (readFails) => {
    let resolveRead!: (value: string | undefined) => void;
    let rejectRead!: (reason: unknown) => void;
    let rejectWrite!: (reason: unknown) => void;
    const read = new Promise<string | undefined>((resolve, reject) => {
      resolveRead = resolve;
      rejectRead = reject;
    });
    const mainAgent = {
      read: vi.fn(() => read),
      write: vi.fn(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectWrite = reject;
          }),
      ),
    };
    const session = { mainAgent } as unknown as RelaySession;
    function Selection() {
      const state = useSavedAgentState(session, "early-read");
      return (
        <>
          <output aria-label="read">{String(state.read)}</output>
          <output aria-label="agent">{state.agent ?? "none"}</output>
          <output aria-label="error">{state.error ?? "none"}</output>
        </>
      );
    }
    render(<Selection />);
    const choosing = chooseDefaultAgent(session, "early-read", "a".repeat(64));
    const rejected = expect(choosing).rejects.toThrow("couldn't be saved");
    try {
      expect(mainAgent.write).toHaveBeenCalledOnce();
      await act(async () => {
        if (readFails) rejectRead(new Error("account offline"));
        else resolveRead("b".repeat(64));
      });
      expect(screen.getByLabelText("read")).toHaveTextContent("false");
      await act(async () => {
        rejectWrite(new Error("write failed"));
        await rejected;
      });
      expect(screen.getByLabelText("read")).toHaveTextContent("true");
      expect(screen.getByLabelText("agent")).toHaveTextContent(
        readFails ? "none" : "b".repeat(64),
      );
      expect(screen.getByLabelText("error")).toHaveTextContent(
        readFails ? "account offline" : "none",
      );
    } finally {
      await act(async () => {
        resolveRead(undefined);
        rejectWrite(new Error("cleanup"));
        await rejected;
      });
    }
  },
);

it("a choice made while the account is read wins, even when already cached", async () => {
  const { account, session, Selection } = accountSession("b".repeat(64));
  setDefaultAgent("account", "a".repeat(64));
  render(<Selection />);
  await act(() => chooseDefaultAgent(session, "account", "a".repeat(64)));
  await act(async () => account.resolve());
  expect(screen.getByRole("status").textContent).toBe("First");
  expect(account.saved()).toBe("a".repeat(64));
});

it("a choice made before a retried account read wins, even while its save is pending", async () => {
  const { account, session, Selection } = accountSession("b".repeat(64));
  account.read.mockRejectedValueOnce(new Error("offline"));
  const { unmount } = render(<Selection />);
  await act(async () => {});
  let save!: () => void;
  account.write.mockImplementationOnce(
    () => new Promise<void>((resolve) => (save = resolve)),
  );
  const choosing = chooseDefaultAgent(session, "account", "a".repeat(64));
  // Shown again while the save is pending: the retried read still names B.
  unmount();
  render(<Selection />);
  await act(async () => account.resolve());
  expect(screen.getByRole("status").textContent).toBe("First");
  await act(async () => {
    save();
    await choosing;
  });
  expect(screen.getByRole("status").textContent).toBe("First");
});

it("uses the account's choice when this device can't cache it", async () => {
  const { account, Selection } = accountSession("b".repeat(64));
  const write = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw new Error("storage full");
    });
  try {
    render(<Selection />);
    await act(async () => account.resolve());
    expect(screen.getByRole("status").textContent).toBe("Second");
  } finally {
    write.mockRestore();
    forgetDefaultAgent("b".repeat(64));
  }
});

it("saves an explicit choice to the account when this device can't cache it", async () => {
  const { account, session, Selection } = accountSession("a".repeat(64));
  render(<Selection />);
  await act(async () => account.resolve());
  const write = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw new Error("storage full");
    });
  try {
    await act(() => chooseDefaultAgent(session, "account", "b".repeat(64)));
    expect(screen.getByRole("status").textContent).toBe("Second");
    expect(account.saved()).toBe("b".repeat(64));
  } finally {
    write.mockRestore();
    forgetDefaultAgent("b".repeat(64));
  }
});

it("still picks a main agent when the account can't be read", async () => {
  const { account, Selection } = accountSession(undefined);
  account.read.mockRejectedValueOnce(new Error("offline"));
  render(<Selection />);
  await act(async () => {});
  expect(screen.getByRole("status").textContent).toBe("First");
});

it("clears the main agent on this device and saves none to the account", async () => {
  const { account, session } = accountSession("b".repeat(64));
  const store = savedAgentStore(session, "clear");
  const stop = store.subscribe(() => {});
  // Not known while the account is read.
  expect(store.known()).toBe(false);
  await act(async () => account.resolve());
  expect(store.snapshot()).toBe("b".repeat(64));
  expect(store.known()).toBe(true);
  expect(readView("clear", "solo:default-agent", null)).toBe("b".repeat(64));
  await clearDefaultAgent(session, "clear");
  expect(account.write).toHaveBeenLastCalledWith(null);
  expect(account.saved()).toBeNull();
  expect(store.snapshot()).toBeUndefined();
  expect(store.known()).toBe(true);
  expect(readView("clear", "solo:default-agent", null)).toBeNull();
  stop();
});

it("knows the account saved none only once its read succeeded", async () => {
  const failing = accountSession(undefined);
  failing.account.read.mockRejectedValueOnce(new Error("offline"));
  const unread = savedAgentStore(failing.session, "unknown");
  const stop = unread.subscribe(() => {});
  await act(async () => {});
  expect(unread.snapshot()).toBeUndefined();
  expect(unread.known()).toBe(false);
  stop();

  const none = accountSession(undefined);
  const read = savedAgentStore(none.session, "none");
  const stopNone = read.subscribe(() => {});
  await act(async () => none.account.resolve());
  expect(read.known()).toBe(true);
  stopNone();
});

it("tells an account that saved none from one with no record", async () => {
  const never = accountSession(undefined);
  const empty = savedAgentStore(never.session, "never");
  const stopNever = empty.subscribe(() => {});
  await act(async () => never.account.resolve());
  expect(empty.known()).toBe(true);
  expect(empty.recorded()).toBe(false);
  stopNever();

  const removed = accountSession(null);
  const none = savedAgentStore(removed.session, "removed");
  const stopRemoved = none.subscribe(() => {});
  await act(async () => removed.account.resolve());
  expect(none.snapshot()).toBeUndefined();
  expect(none.known()).toBe(true);
  expect(none.recorded()).toBe(true);
  stopRemoved();

  // Removing a Bestie here saves a record of none.
  const cleared = accountSession(undefined);
  const store = savedAgentStore(cleared.session, "cleared");
  const stop = store.subscribe(() => {});
  await act(async () => cleared.account.resolve());
  await clearDefaultAgent(cleared.session, "cleared");
  expect(store.recorded()).toBe(true);
  stop();
});

it("brings this device's choice back when none can't be saved to the account", async () => {
  const { account, session } = accountSession("b".repeat(64));
  setDefaultAgent("unsaved-clear", "b".repeat(64));
  account.write.mockRejectedValueOnce(new Error("offline"));
  await expect(clearDefaultAgent(session, "unsaved-clear")).rejects.toThrow(
    "Removing your Bestie couldn't be saved to your account. Try again.",
  );
  expect(readView("unsaved-clear", "solo:default-agent", null)).toBe(
    "b".repeat(64),
  );
  expect(account.saved()).toBe("b".repeat(64));
  expect(savedAgentStore(session, "unsaved-clear").known()).toBe(false);
});

it("doesn't know the account saved none while a save is pending or after one failed during its read", async () => {
  const { account, session } = accountSession("b".repeat(64));
  const store = savedAgentStore(session, "pending-clear");
  const stop = store.subscribe(() => {});
  account.write.mockRejectedValueOnce(new Error("offline"));
  const clearing = expect(
    clearDefaultAgent(session, "pending-clear"),
  ).rejects.toThrow();
  await act(async () => account.resolve());
  await clearing;
  // The removal failed, so the read's B comes back, but a removal was asked
  // for during that read, so the account's choice isn't known.
  expect(store.snapshot()).toBe("b".repeat(64));
  expect(store.known()).toBe(false);

  let save!: () => void;
  account.write.mockImplementationOnce(
    () => new Promise<void>((resolve) => (save = resolve)),
  );
  const retry = clearDefaultAgent(session, "pending-clear");
  expect(store.known()).toBe(false);
  await act(async () => {
    save();
    await retry;
  });
  expect(store.known()).toBe(true);
  stop();
});

it("brings the removed Bestie back over an automatic pick, but not over a newer choice", async () => {
  const { account, session } = accountSession("b".repeat(64));
  setDefaultAgent("auto-clear", "b".repeat(64));
  let fail!: () => void;
  account.write.mockImplementationOnce(
    () => new Promise<void>((_, reject) => (fail = () => reject(new Error()))),
  );
  const clearing = clearDefaultAgent(session, "auto-clear");
  // A composer picks a fallback while the save is pending.
  setDefaultAgent("auto-clear", "a".repeat(64));
  fail();
  await expect(clearing).rejects.toThrow();
  expect(readView("auto-clear", "solo:default-agent", null)).toBe(
    "b".repeat(64),
  );

  account.write.mockImplementationOnce(
    () => new Promise<void>((_, reject) => (fail = () => reject(new Error()))),
  );
  const again = clearDefaultAgent(session, "auto-clear");
  const choosing = chooseDefaultAgent(session, "auto-clear", "a".repeat(64));
  fail();
  await expect(again).rejects.toThrow();
  await choosing;
  expect(readView("auto-clear", "solo:default-agent", null)).toBe(
    "a".repeat(64),
  );
});

it("a choice in another community doesn't keep a failed removal from coming back", async () => {
  const here = accountSession("b".repeat(64));
  const there = accountSession("a".repeat(64));
  setDefaultAgent("turn-here", "b".repeat(64));
  let fail!: () => void;
  here.account.write.mockImplementationOnce(
    () => new Promise<void>((_, reject) => (fail = () => reject(new Error()))),
  );
  const clearing = clearDefaultAgent(here.session, "turn-here");
  await chooseDefaultAgent(there.session, "turn-there", "a".repeat(64));
  fail();
  await expect(clearing).rejects.toThrow();
  expect(readView("turn-here", "solo:default-agent", null)).toBe(
    "b".repeat(64),
  );
});

/** The owner's session for their agents' Bestie tools: the real choices over
 * their local agents here, beside one someone else owns and one in another
 * community, and an account record. */
function ownerSession(saved: string | null | undefined) {
  const owner = "f".repeat(64);
  const agent = (pubkey: string, more: object = {}) => ({
    pubkey,
    name: pubkey.slice(0, 1),
    relayUrl: "wss://relay.example.test",
    owner,
    ...more,
  });
  let local: { status: "ready" | "error"; agents: object[]; error?: string } = {
    status: "ready",
    agents: [
      agent("a".repeat(64)),
      agent("b".repeat(64)),
      agent("c".repeat(64), { owner: "e".repeat(64) }),
      agent("d".repeat(64), { relayUrl: "wss://other.example.test" }),
    ],
  };
  let held: Promise<void> | undefined;
  const inventory = vi.fn(async () => held);
  const account = {
    read: vi.fn(async () => saved),
    write: vi.fn(async (agent: string | null) => {
      saved = agent;
    }),
  };
  const session = {
    mainAgent: account,
    agentChoices: createAgentChoices({
      scope: `https://relay.example.test:${owner}`,
      library: createAgentLibrary(undefined).queries,
      native: {
        snapshot: () => local,
        subscribe: () => () => {},
        refresh: inventory,
      } as unknown as Parameters<typeof createAgentChoices>[0]["native"],
      signal: new AbortController().signal,
    }),
  } as unknown as RelaySession;
  return {
    session,
    account,
    fail: (error: string) => {
      local = { status: "error", agents: [], error };
    },
    inventory,
    /** Holds inventory reads until the returned release runs. */
    hold: () => {
      let release!: () => void;
      held = new Promise((resolve) => {
        release = resolve;
      });
      return () => {
        held = undefined;
        release();
      };
    },
  };
}

it("an agent's Bestie change saves an owned agent to the device and the account", async () => {
  const pubkey = "b".repeat(64);
  const { session, account } = ownerSession(undefined);
  const bestie = defaultAgentControl(session, "bestie-set");
  expect(await bestie.set(pubkey)).toEqual({
    device: pubkey,
    account: pubkey,
    here: true,
  });
  expect(readView("bestie-set", "solo:default-agent", null)).toBe(pubkey);
  expect(account.write).toHaveBeenCalledExactlyOnceWith(pubkey);
  expect(await bestie.read()).toEqual({
    device: pubkey,
    account: pubkey,
    here: true,
  });
});

it("an agent's Bestie removal saves none to the device and the account", async () => {
  const { session, account } = ownerSession("a".repeat(64));
  setDefaultAgent("bestie-clear", "a".repeat(64));
  const bestie = defaultAgentControl(session, "bestie-clear");
  const none = { device: null, account: null, here: false };
  expect(await bestie.clear()).toEqual(none);
  expect(account.write).toHaveBeenCalledExactlyOnceWith(null);
  expect(readView("bestie-clear", "solo:default-agent", null)).toBeNull();
  expect(await bestie.read()).toEqual(none);
});

it("refuses an agent the owner doesn't own or can't tag here, or that doesn't exist, changing nothing", async () => {
  const { session, account, fail } = ownerSession("a".repeat(64));
  setDefaultAgent("bestie-refused", "a".repeat(64));
  const bestie = defaultAgentControl(session, "bestie-refused");
  // Someone else's, one in another community, an unknown key, and a name.
  for (const agent of ["c", "d", "9"].map((c) => c.repeat(64)).concat("a"))
    await expect(bestie.set(agent)).rejects.toThrow(
      "Only an agent your owner owns and can tag in this community can be their Bestie.",
    );
  // An inventory that can't be read says so, rather than that it isn't theirs.
  fail("Agents couldn't be read.");
  await expect(bestie.set("b".repeat(64))).rejects.toThrow(
    "Agents couldn't be read.",
  );
  await expect(bestie.read()).rejects.toThrow("Agents couldn't be read.");
  expect(account.write).not.toHaveBeenCalled();
  expect(readView("bestie-refused", "solo:default-agent", null)).toBe(
    "a".repeat(64),
  );
});

it("saves nothing when the agent's turn ends while its Bestie change reads the agents", async () => {
  const { session, account, inventory, hold } = ownerSession("a".repeat(64));
  setDefaultAgent("bestie-ended", "a".repeat(64));
  const release = hold();
  let ended = false;
  const setting = defaultAgentControl(session, "bestie-ended").set(
    "b".repeat(64),
    () => {
      if (ended) throw new Error("The turn has ended");
    },
  );
  try {
    expect(inventory).toHaveBeenCalledOnce();
    ended = true;
  } finally {
    release();
  }
  await expect(setting).rejects.toThrow("The turn has ended");
  expect(account.write).not.toHaveBeenCalled();
  expect(readView("bestie-ended", "solo:default-agent", null)).toBe(
    "a".repeat(64),
  );
});

it("refuses an agent's Bestie change while another is still saving", async () => {
  const { session, account } = ownerSession("a".repeat(64));
  setDefaultAgent("bestie-busy", "a".repeat(64));
  let finish!: () => void;
  account.write.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  // Make my bestie, still saving to the account.
  const choosing = chooseDefaultAgent(session, "bestie-busy", "b".repeat(64));
  const bestie = defaultAgentControl(session, "bestie-busy");
  const busy =
    "Another change to your owner's Bestie is still saving. Try again.";
  try {
    await expect(bestie.set("a".repeat(64))).rejects.toThrow(busy);
    await expect(bestie.clear()).rejects.toThrow(busy);
  } finally {
    finish();
  }
  await choosing;
  expect(account.write).toHaveBeenCalledExactlyOnceWith("b".repeat(64));
  expect(readView("bestie-busy", "solo:default-agent", null)).toBe(
    "b".repeat(64),
  );
});

it.each([
  ["set", "b".repeat(64)],
  ["clear", null],
] as const)(
  "refuses an agent's Bestie change until a failed %s has put back the previous choice",
  async (_first, agent) => {
    // Whichever moment the second change finishes reading the agents, before
    // or after the first one's save fails, device and account still match.
    for (let ticks = -8; ticks <= 8; ticks++) {
      const scope = `bestie-rollback-${agent ? "set" : "clear"}-${ticks}`;
      const previous = "a".repeat(64);
      const { session, account, hold } = ownerSession(previous);
      setDefaultAgent(scope, previous);
      let refuse!: (error: Error) => void;
      account.write
        .mockImplementationOnce(
          () =>
            new Promise<void>((_, reject) => {
              refuse = reject;
            }),
        )
        .mockRejectedValueOnce(new Error("offline"));
      const bestie = defaultAgentControl(session, scope);
      const first = agent ? bestie.set(agent) : bestie.clear();
      await vi.waitFor(() => expect(account.write).toHaveBeenCalledOnce());
      const release = hold();
      const second = bestie.set(previous);
      const later = async (count: number) => {
        for (let tick = 0; tick < count; tick++) await Promise.resolve();
      };
      try {
        if (ticks < 0) {
          release();
          await later(-ticks);
          refuse(new Error("offline"));
        } else {
          refuse(new Error("offline"));
          await later(ticks);
          release();
        }
      } finally {
        release();
      }
      await Promise.allSettled([first, second]);
      expect(await account.read()).toBe(previous);
      expect(readView(scope, "solo:default-agent", null)).toBe(previous);
    }
  },
);

it("keeps a newer Bestie choice still saving when an agent's change to the same agent fails", async () => {
  const pubkey = "b".repeat(64);
  const { session, account } = ownerSession("a".repeat(64));
  setDefaultAgent("bestie-newer", "a".repeat(64));
  let refuse!: (error: Error) => void;
  let finish!: () => void;
  account.write
    .mockImplementationOnce(
      () =>
        new Promise<void>((_, reject) => {
          refuse = reject;
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
  const setting = defaultAgentControl(session, "bestie-newer").set(pubkey);
  await vi.waitFor(() => expect(account.write).toHaveBeenCalledOnce());
  const choosing = chooseDefaultAgent(session, "bestie-newer", pubkey);
  try {
    refuse(new Error("offline"));
    await expect(setting).rejects.toThrow(
      "Your bestie couldn't be saved to your account. Try again.",
    );
    expect(readView("bestie-newer", "solo:default-agent", null)).toBe(pubkey);
  } finally {
    finish();
  }
  await choosing;
  expect(readView("bestie-newer", "solo:default-agent", null)).toBe(pubkey);
});

it("keeps the previous choice when an agent's Bestie change can't be saved to the account", async () => {
  const previous = "a".repeat(64);
  const { session, account } = ownerSession(previous);
  setDefaultAgent("bestie-unsaved", previous);
  account.write.mockRejectedValueOnce(new Error("offline"));
  const bestie = defaultAgentControl(session, "bestie-unsaved");
  await expect(bestie.set("b".repeat(64))).rejects.toThrow(
    "Your bestie couldn't be saved to your account. Try again.",
  );
  expect(await bestie.read()).toEqual({
    device: previous,
    account: previous,
    here: true,
  });
  // With no previous choice, none is kept.
  const first = ownerSession(undefined);
  first.account.write.mockRejectedValueOnce(new Error("offline"));
  await expect(
    defaultAgentControl(first.session, "bestie-first").set("b".repeat(64)),
  ).rejects.toThrow(
    "Your bestie couldn't be saved to your account. Try again.",
  );
  expect(readView("bestie-first", "solo:default-agent", null)).toBeNull();
});

it("reads a stale Bestie as not here, beside what the account saved", async () => {
  const stale = "9".repeat(64);
  const { session } = ownerSession(stale);
  setDefaultAgent("bestie-stale", stale);
  expect(await defaultAgentControl(session, "bestie-stale").read()).toEqual({
    device: stale,
    account: stale,
    here: false,
  });
});

it("reads whether the Bestie it reports is here, though the device changes during the read", async () => {
  const chosen = "a".repeat(64);
  const { session, inventory, hold } = ownerSession(chosen);
  setDefaultAgent("bestie-moved", chosen);
  const release = hold();
  const reading = defaultAgentControl(session, "bestie-moved").read();
  try {
    await vi.waitFor(() => expect(inventory).toHaveBeenCalledOnce());
    setDefaultAgent("bestie-moved", "9".repeat(64));
  } finally {
    release();
  }
  expect(await reading).toEqual({
    device: chosen,
    account: chosen,
    here: true,
  });
});
