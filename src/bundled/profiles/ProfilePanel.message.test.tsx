// @vitest-environment jsdom
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
stubAvatarBrowserApis();
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Navigation } from "../../features/navigation/controller";
import { createRelaySession } from "../../features/relay/session";
import type { RelayData, RelaySnapshot } from "../../features/relay/service";
import { profileTarget } from "../../features/profiles/target";
import { ProfilePanel } from "./ProfilePanel";

const viewer = "b".repeat(64);
const person = "a".repeat(64);
const other = "c".repeat(64);
const origin = "https://relay.example.test";
afterEach(cleanup);

function fixture(available = true) {
  const owner = createRelaySession(null);
  const open =
    vi.fn<(keys: readonly string[], signal: AbortSignal) => Promise<string>>();
  let choices = owner.session.agentChoices.snapshot();
  const choiceListeners = new Set<() => void>();
  const session = {
    ...owner.session,
    directMessages: { ...owner.session.directMessages, available, open },
    agentChoices: {
      ...owner.session.agentChoices,
      snapshot: () => choices,
      subscribe(listener: () => void) {
        choiceListeners.add(listener);
        return () => choiceListeners.delete(listener);
      },
    },
  };
  /** Makes `person` a known agent with local control or hosted DM evidence. */
  const agent = (eligibility: boolean | "hosted", notify = true) => {
    choices = {
      ...choices,
      status: "ready",
      identities: [
        {
          pubkey: person,
          name: "Agent",
          managed: eligibility === true,
          ...(eligibility === "hosted" ? { messageable: true as const } : {}),
        },
      ],
    };
    if (notify)
      act(() => {
        for (const listener of choiceListeners) listener();
      });
  };
  const failChoices = () => {
    choices = { ...choices, status: "error", identities: [] };
    act(() => {
      for (const listener of choiceListeners) listener();
    });
  };
  let snapshot: RelaySnapshot = {
    status: "ready",
    generation: 1,
    scope: `${origin}:${viewer}`,
    viewer,
    session,
  };
  const listeners = new Set<() => void>();
  const relay: RelayData = {
    snapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    retry() {},
    tryAgain() {},
    disconnect() {},
    clearCache: async () => {},
  };
  const navigate = vi.fn(async () => ({ status: "opened" as const }));
  const navigation = { open: navigate } as unknown as Navigation;
  const panel = (pubkey: string, agentHint = false) => (
    <ProfilePanel
      relay={relay}
      navigation={navigation}
      target={profileTarget(pubkey, { agent: agentHint }) ?? ""}
      close={() => {}}
    />
  );
  const reconnect = (scope: string) =>
    act(() => {
      snapshot = { ...snapshot, generation: 2, scope };
      for (const listener of listeners) listener();
    });
  return { owner, open, navigate, panel, reconnect, agent, failChoices };
}
function deferred() {
  let resolve!: (id: string) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<string>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const message = () => screen.queryByRole("button", { name: "Message" });
const editProfile = () =>
  screen.queryByRole("button", { name: "Edit profile" });

it("offers Edit profile only on the viewer's own profile in a community and opens its Settings there", () => {
  const f = fixture();
  const view = render(f.panel(person));
  expect(message()).toBeTruthy();
  expect(editProfile()).toBeNull();
  view.rerender(f.panel(viewer));
  expect(message()).toBeNull();
  fireEvent.click(editProfile() as HTMLElement);
  expect(f.navigate).toHaveBeenCalledExactlyOnceWith({
    version: 1,
    kind: "settings",
    section: "profile",
    scope: { viewer, communityOrigin: origin },
  });
  // A scope for another identity names no community for this viewer.
  f.reconnect(`${origin}:${other}`);
  expect(screen.getByRole("region", { name: "Profile details" })).toBeTruthy();
  expect(editProfile()).toBeNull();
  f.owner.dispose();
});

it("offers Message only for a foreign profile on a DM-capable connection", () => {
  const unavailable = fixture(false);
  const view = render(unavailable.panel(person));
  expect(message()).toBeNull();
  view.unmount();
  unavailable.owner.dispose();
  const f = fixture();
  const next = render(f.panel(viewer));
  expect(message()).toBeNull();
  next.rerender(f.panel(person));
  expect(message()).toBeTruthy();
  f.owner.dispose();
});

it.each([true, "hosted"] as const)(
  "offers Message to a known agent with current eligibility (%s)",
  (eligibility) => {
    const f = fixture();
    f.agent(false);
    const view = render(f.panel(person));
    expect(message()).toBeNull();
    f.agent(eligibility);
    expect(message()).toBeTruthy();
    f.agent(false);
    expect(message()).toBeNull();
    view.unmount();
    f.owner.dispose();
  },
);

it("does not offer Message for an agent-hinted profile after native choices fail", () => {
  const f = fixture();
  const view = render(f.panel(person, true));
  expect(message()).toBeNull();
  f.agent(true);
  expect(message()).toBeTruthy();
  f.failChoices();
  expect(message()).toBeNull();
  view.unmount();
  f.owner.dispose();
});

it.each([true, "hosted"] as const)(
  "rechecks agent messaging eligibility on activation (%s)",
  async (eligibility) => {
    const f = fixture();
    f.agent(eligibility);
    f.open.mockResolvedValue("dm-1");
    render(f.panel(person));
    f.agent(false, false);
    fireEvent.click(message() as HTMLElement);
    expect(f.open).not.toHaveBeenCalled();
    f.agent(eligibility, false);
    fireEvent.click(message() as HTMLElement);
    expect(f.open).toHaveBeenCalledWith([person], expect.any(AbortSignal));
    await waitFor(() => expect(f.navigate).toHaveBeenCalledOnce());
    f.owner.dispose();
  },
);

it("opens the DM, shows pending state, then navigates in the captured scope", async () => {
  const f = fixture();
  const opening = deferred();
  f.open.mockReturnValueOnce(opening.promise);
  render(f.panel(person));
  fireEvent.click(message() as HTMLElement);
  expect(f.open).toHaveBeenCalledWith([person], expect.any(AbortSignal));
  expect(message()?.getAttribute("aria-busy")).toBe("true");
  fireEvent.click(message() as HTMLElement);
  expect(f.open).toHaveBeenCalledOnce();
  await act(async () => opening.resolve("dm-1"));
  expect(f.navigate).toHaveBeenCalledWith({
    version: 1,
    kind: "conversation",
    channelId: "dm-1",
    scope: { viewer, communityOrigin: origin },
  });
  expect(message()?.getAttribute("aria-busy")).not.toBe("true");
  f.owner.dispose();
});

it("shows a failure and retries", async () => {
  const f = fixture();
  f.open.mockRejectedValueOnce(new Error("Relay refused the DM."));
  render(f.panel(person));
  fireEvent.click(message() as HTMLElement);
  expect(await screen.findByText("Relay refused the DM.")).toBeTruthy();
  expect(f.navigate).not.toHaveBeenCalled();
  f.open.mockResolvedValueOnce("dm-1");
  fireEvent.click(message() as HTMLElement);
  await waitFor(() => expect(f.navigate).toHaveBeenCalledOnce());
  expect(screen.queryByText("Relay refused the DM.")).toBeNull();
  f.owner.dispose();
});

it.each([
  [
    "target",
    (f: ReturnType<typeof fixture>, view: ReturnType<typeof render>) =>
      view.rerender(f.panel(other)),
  ],
  [
    "community",
    (f: ReturnType<typeof fixture>) =>
      f.reconnect(`https://other.example.test:${viewer}`),
  ],
])("aborts and ignores a late open after %s change", async (_name, change) => {
  const f = fixture();
  const opening = deferred();
  f.open.mockReturnValueOnce(opening.promise);
  const view = render(f.panel(person));
  fireEvent.click(message() as HTMLElement);
  const signal = f.open.mock.calls[0]?.[1];
  change(f, view);
  expect(signal?.aborted).toBe(true);
  await act(async () => opening.resolve("dm-1"));
  expect(f.navigate).not.toHaveBeenCalled();
  f.owner.dispose();
});
