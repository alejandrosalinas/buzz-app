// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import type { RelayData } from "../../../features/relay/service";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, useState } from "react";
import { AgentSaveFooter } from "../../../features/agents/AgentSaveButton";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAgentSettingsHost } from "../../agents/AgentSettingsHost";
import { AgentTabs } from "../../agents/AgentTabs";
import type { Agents, Agent } from "../../../features/agents/service";
import type { Host, HostResponse } from "../../../features/host/service";
import { createAgentClient } from "../agents/client";
import { createOAuthSession } from "../oauth/session";
import { deferred } from "../test-helpers";
import { builderlabType } from "./index";
import { PanelCard } from "../../../features/panels/PanelCard";

vi.mock("../oauth/browser", async (original) => ({
  ...(await original<typeof import("../oauth/browser")>()),
  browserLoginAvailable: () => true,
}));

const first = "ab".repeat(32);
const second = "cd".repeat(32);
const agent = (pubkey = first): Agent => ({
  key: pubkey,
  pubkey,
  name: "Helper",
  type: "block.builderlab/builderlab",
  owner: "ef".repeat(32),
  relay: "wss://community.example",
  place: "hosted",
  config: {},
  attention: {},
  skipped: {},
  attentionEnabled: true,
  timers: {},
});
const response = (): HostResponse => ({
  status: 200,
  headers: {},
  body: JSON.stringify({
    status: 1,
    agents: [
      {
        agent_id: "one",
        agent_pubkey: first,
        agent_name: "Helper",
        status: 2,
        agent_instructions: "First instructions.",
      },
      {
        agent_id: "two",
        agent_pubkey: second,
        agent_name: "Other",
        status: 2,
        agent_instructions: "Second instructions.",
      },
    ],
  }),
});
beforeEach(() =>
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example"),
);
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
async function fixture(signedIn = true) {
  let subject = "account-a";
  let email = "a@example.com";
  let canUseRemoteAgents = true;
  const acquire = vi.fn(async () => ({
    value: "credential",
    account: {
      subject,
      email,
      canUseRemoteAgents,
      canUseBuilderlabDecisions: false,
    },
  }));
  const release = vi.fn();
  const session = createOAuthSession(acquire, release, {
    request: (input) => request(input),
  });
  if (signedIn) await session.signIn();
  let stored = response();
  const request = vi.fn<Host["request"]>(async ({ url, body }) => {
    if (url.endsWith("/update-agent")) {
      const update = JSON.parse(body ?? "{}");
      const data = JSON.parse(stored.body);
      data.agents = data.agents.map((row: { agent_pubkey: string }) =>
        row.agent_pubkey === update.agent_pubkey
          ? {
              ...row,
              ...update,
              ...(update.model_id ? { model_selection_status: 1 } : {}),
            }
          : row,
      );
      stored = { ...stored, body: JSON.stringify(data) };
    }
    return url.endsWith("/get-model-catalog")
      ? {
          status: 200,
          headers: {},
          body: JSON.stringify({
            models: [
              {
                id: "one",
                display_name: "Friendly Model",
                supported_reasoning_efforts: ["high"],
              },
            ],
          }),
        }
      : stored;
  });
  const client = createAgentClient(session);
  const disconnected = { status: "disconnected", generation: 0 };
  const type = {
    ...builderlabType(client, session, {
      snapshot: () => disconnected,
      subscribe: () => () => {},
    } as unknown as RelayData),
    key: "block.builderlab/builderlab",
    pluginId: "block.builderlab",
    revision: "test",
  };
  const Tab = type.tabs?.[0]?.component;
  if (!Tab) throw new Error("Missing Builderlab settings");
  return {
    Tab,
    client,
    type,
    request,
    session,
    acquire,
    release,
    prepareAccount(next: {
      subject: string;
      email: string;
      canUseRemoteAgents: boolean;
    }) {
      subject = next.subject;
      email = next.email;
      canUseRemoteAgents = next.canUseRemoteAgents;
    },
    changeAccount: async () => {
      subject = "account-b";
      session.signOut();
      await session.signIn();
    },
  };
}
async function loadedInstructions() {
  const field = screen.getByRole("textbox", { name: "Instructions" });
  await waitFor(() => expect(field).toBeEnabled());
  return field;
}
it("automatically signs in on Identity without provider reads before verification", async () => {
  const h = await fixture(false);
  const acquire = h.acquire.getMockImplementation();
  if (!acquire) throw new Error("Missing sign-in fixture");
  const held = deferred<Awaited<ReturnType<typeof h.acquire>>>();
  h.acquire.mockReturnValueOnce(held.promise);
  const signIn = vi.spyOn(h.session, "signIn");
  renderTabs(h);
  const harness = screen.getByRole("button", {
    name: "Change harness from Builderlab",
  });
  const mark = harness.querySelector("svg");
  expect(mark).toHaveAttribute("width", "1.25rem");
  expect(screen.getByRole("button", { name: "Model:" })).toBeDisabled();
  expect(screen.queryByRole("textbox", { name: "Instructions" })).toBeNull();
  const inlineSignIn = screen.getByRole("button", {
    name: "Cancel sign-in",
  });
  expect(inlineSignIn.parentElement).toBe(
    harness.closest(".buzz-select")?.parentElement,
  );
  expect(inlineSignIn).toHaveAttribute("aria-busy", "true");
  expect(
    screen.queryByRole("region", { name: "Sign in to Builderlab" }),
  ).toBeNull();
  expect(signIn).toHaveBeenCalledOnce();
  expect(h.request).not.toHaveBeenCalled();
  const user = userEvent.setup();
  await act(async () => {
    held.resolve(await acquire());
    await signIn.mock.results[0]?.value;
  });
  expect(await loadedInstructions()).toHaveValue("First instructions.");
  expect(
    screen.getByRole("button", { name: "Change harness from Builderlab" }),
  ).toBe(harness);
  expect(harness.querySelector("svg")).toBe(mark);
  await user.type(
    screen.getByRole("textbox", { name: "Instructions" }),
    " Draft",
  );
  act(() => h.session.signOut());
  expect(screen.queryByRole("textbox", { name: "Instructions" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  expect(signIn).toHaveBeenCalledTimes(1);
  await act(() => h.session.signIn());
  expect(await loadedInstructions()).toHaveValue("First instructions. Draft");
  h.session.dispose();
});

it.each(["cancel", "timeout"] as const)(
  "keeps automatic login and %s recovery in the actual Harness row without a sheet",
  async (outcome) => {
    const h = await fixture(false);
    const held = deferred<Awaited<ReturnType<typeof h.acquire>>>();
    h.acquire.mockReturnValueOnce(held.promise);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    renderTabs(h);
    try {
      expect(h.acquire).toHaveBeenCalledOnce();
      await act(() => vi.advanceTimersByTimeAsync(3000));
      const cancel = screen.getByRole("button", { name: "Cancel sign-in" });
      const harness = screen.getByRole("button", {
        name: "Change harness from Builderlab",
      });
      expect(cancel.parentElement).toBe(
        harness.closest(".buzz-select")?.parentElement,
      );
      expect(screen.queryByRole("region")).toBeNull();
      const row = harness.closest(".buzz-preference-row");
      expect(screen.queryByText(/Finish signing in/)).toBeNull();
      expect(screen.queryByText(/Sign in to edit settings/)).toBeNull();
      if (outcome === "cancel") fireEvent.click(cancel);
      else
        await act(async () =>
          held.reject(new Error("Builderlab authentication timed out")),
        );
      await act(() => vi.advanceTimersByTimeAsync(10_000));
      const retry = screen.getByRole("button", {
        name: "Sign in to Builderlab",
      });
      expect(retry).toBeEnabled();
      const guidance = screen.getByText(
        "Sign in to edit settings. You can still message this agent.",
      );
      expect(row).not.toContainElement(guidance);
      expect(row?.parentElement).toContainElement(guidance);
      expect(screen.queryByRole("region")).toBeNull();
      expect(h.acquire).toHaveBeenCalledOnce();
      expect(h.request).not.toHaveBeenCalled();
      vi.useRealTimers();
      fireEvent.click(retry);
      await screen.findByRole("textbox", { name: "Instructions" });
      expect(await loadedInstructions()).toHaveValue("First instructions.");
      expect(h.acquire).toHaveBeenCalledTimes(2);
      expect(
        screen.queryByRole("button", { name: "Sign in to Builderlab" }),
      ).toBeNull();
    } finally {
      held.resolve({
        value: "late-credential",
        account: {
          subject: "account-a",
          email: "a@example.com",
          canUseRemoteAgents: true,
          canUseBuilderlabDecisions: false,
        },
      });
      h.session.dispose();
    }
  },
);

it("offers retry after a slow settings read and ignores its late result", async () => {
  const h = await fixture(false);
  await h.session.signIn();
  const held = deferred<HostResponse>();
  h.request.mockReturnValueOnce(held.promise);
  vi.useFakeTimers();
  render(<h.Tab agent={agent()} save={vi.fn()} />);
  await act(() => vi.advanceTimersByTimeAsync(2999));
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(
    screen.getByRole("button", { name: "Model: Still loading…" }),
  ).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  vi.useRealTimers();
  expect(await loadedInstructions()).toHaveValue("First instructions.");
  const stale = JSON.parse(response().body);
  stale.agents[0].agent_instructions = "Stale instructions";
  await act(async () => {
    held.resolve({ ...response(), body: JSON.stringify(stale) });
  });
  expect(screen.getByRole("textbox", { name: "Instructions" })).toHaveValue(
    "First instructions.",
  );
  h.session.dispose();
});

it.each([false, true])(
  "keeps the full form mounted across settings and catalog loading (catalog fails: %s)",
  async (fails) => {
    const h = await fixture();
    const user = userEvent.setup();
    const settings = deferred<HostResponse>();
    const catalog = deferred<HostResponse>();
    const data = JSON.parse(response().body);
    Object.assign(data.agents[0], {
      model_id: "one",
      reasoning_effort: "high",
      model_selection_status: 1,
    });
    const settingsResponse = { ...response(), body: JSON.stringify(data) };
    const request = h.request.getMockImplementation();
    if (!request) throw new Error("Missing request fixture");
    h.request.mockImplementation((input) => {
      if (input.url.endsWith("/list-agents")) return settings.promise;
      if (input.url.endsWith("/get-model-catalog")) return catalog.promise;
      return request(input);
    });
    renderTabs(h);
    const field = screen.getByRole("textbox", { name: "Instructions" });
    const harness = screen.getByRole("button", {
      name: "Change harness from Builderlab",
    });
    const mark = harness.querySelector("svg");
    const model = screen.getByRole("button", { name: "Model: …" });
    const thinking = screen.getByRole("combobox", { name: "Thinking" });
    const region = field.closest("[aria-busy]");
    try {
      expect(mark).toHaveAttribute("width", "1.25rem");
      expect(mark).toHaveAttribute("aria-hidden", "true");
      await waitFor(() =>
        expect(h.request).toHaveBeenCalledWith(
          expect.objectContaining({
            url: expect.stringContaining("/list-agents"),
          }),
        ),
      );
      expect(region).toHaveAttribute("aria-busy", "true");
      expect(region?.querySelector(".sr-only")).toBeInTheDocument();
      expect(region?.querySelector(".buzz-loading-region-feedback")).toBeNull();
      expect(model).toBeDisabled();
      expect(model.querySelector(".buzz-select-leading")).toBeNull();
      expect(thinking).toBeDisabled();
      expect(field).toBeDisabled();
      expect(field).toHaveValue("");
      await user.type(field, "Must not become a draft.");
      expect(field).toHaveValue("");
      expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
      act(() => harness.focus());
      await act(async () => settings.resolve(settingsResponse));
      await waitFor(() => expect(field).toBeEnabled());
      await waitFor(() =>
        expect(h.request).toHaveBeenCalledWith(
          expect.objectContaining({
            url: expect.stringContaining("/get-model-catalog"),
          }),
        ),
      );
      expect(harness).toHaveFocus();
      expect(harness.querySelector("svg")).toBe(mark);
      expect(screen.getByRole("textbox", { name: "Instructions" })).toBe(field);
      expect(field).toHaveValue("First instructions.");
      expect(region).toHaveAttribute("aria-busy", "true");
      expect(region?.querySelector(".sr-only")).toBeInTheDocument();
      expect(model).toBeDisabled();
      expect(thinking).toBeDisabled();
      await user.type(field, " Draft.");
      if (fails) {
        await act(async () =>
          catalog.resolve({ status: 400, headers: {}, body: "{}" }),
        );
        expect(await screen.findByRole("alert")).toHaveTextContent("HTTP 400");
        expect(model).toHaveTextContent("—");
        expect(thinking).toHaveTextContent("—");
        expect(model.querySelector(".buzz-select-leading")).toBeNull();
        expect(model).toBeDisabled();
        expect(thinking).toBeDisabled();
        h.request.mockImplementation(request);
        await user.click(screen.getByRole("button", { name: "Retry models" }));
      } else {
        const result = await request({
          url: "https://builderlab.example/get-model-catalog",
          method: "POST",
        });
        await act(async () => catalog.resolve(result));
      }
      await waitFor(() => expect(model).toBeEnabled());
      expect(model).toHaveTextContent("Friendly Model");
      expect(thinking).toHaveTextContent("High");
      expect(region).toHaveAttribute("aria-busy", "false");
      expect(harness.querySelector("svg")).toBe(mark);
      expect(field).toHaveValue("First instructions. Draft.");
      expect(screen.getByRole("button", { name: /^Model:/ })).toBe(model);
      expect(screen.getByRole("combobox", { name: "Thinking" })).toBe(thinking);
      expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    } finally {
      await act(async () => {
        settings.resolve(response());
        catalog.resolve({ status: 200, headers: {}, body: '{"models":[]}' });
      });
    }
  },
);
it("hides a failed settings load and Retry while signed out, then loads after explicit sign-in", async () => {
  const h = await fixture();
  h.request.mockResolvedValueOnce({ ...response(), status: 400 });
  render(<h.Tab agent={agent()} save={vi.fn()} />, { wrapper: StrictMode });
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("HTTP 400");
  expect(
    screen.getByRole("region", { name: "Couldn’t load settings" }),
  ).toContainElement(alert);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Retry" })).toBeVisible(),
  );
  const before = h.request.mock.calls.length;
  const signIn = vi.spyOn(h.session, "signIn");
  act(() => h.session.signOut());
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  expect(screen.queryByRole("textbox", { name: "Instructions" })).toBeNull();
  expect(signIn).not.toHaveBeenCalled();
  expect(h.request).toHaveBeenCalledTimes(before);
  await act(() => h.session.signIn());
  expect(await loadedInstructions()).toHaveValue("First instructions.");
  expect(screen.queryByRole("alert")).toBeNull();
});
// Match the desktop opener's unprevented HTTP(S) anchor activation boundary.
function observeLogout(
  session: Awaited<ReturnType<typeof fixture>>["session"],
) {
  const opened: { url: string; status: string }[] = [];
  const opener = (event: MouseEvent) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.altKey
    )
      return;
    const anchor = event
      .composedPath()
      .find(
        (node): node is HTMLAnchorElement => node instanceof HTMLAnchorElement,
      );
    if (anchor?.target !== "_blank" || !/^https?:$/.test(anchor.protocol))
      return;
    opened.push({ url: anchor.href, status: session.snapshot().status });
    // The native opener consumes the navigation; jsdom has no system browser.
    event.preventDefault();
  };
  window.addEventListener("click", opener);
  return { opened, stop: () => window.removeEventListener("click", opener) };
}

it.each([
  { canUseRemoteAgents: true, activation: "pointer" },
  { canUseRemoteAgents: false, activation: "Enter" },
  { canUseRemoteAgents: true, activation: "Space" },
])(
  "signs out before opening browser logout and preserves a mismatched draft ($activation, remote access: $canUseRemoteAgents)",
  async ({ canUseRemoteAgents, activation }) => {
    vi.stubEnv(
      "VITE_BUZZ_BUILDERLAB_URL",
      "https://staging.builderlab.example:8443/api",
    );
    const h = await fixture();
    render(<h.Tab agent={agent()} save={vi.fn()} />);
    let field = await loadedInstructions();
    const user = userEvent.setup();
    await user.type(field, " Draft");
    const reads = h.request.mock.calls.length;
    h.prepareAccount({
      subject: "account-b",
      email: "b@example.com",
      canUseRemoteAgents,
    });
    await act(() => h.session.signIn());
    field = screen.getByRole("textbox", { name: "Instructions" });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "Sign in as a@example.com to edit this agent.",
    );
    expect(alert).not.toHaveTextContent("b@example.com");
    expect(
      screen.getByRole("region", { name: "Different account needed" }),
    ).toContainElement(alert);
    expect(screen.getByRole("button", { name: /^Model:/ })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Thinking" })).toBeDisabled();
    expect(field).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: /Switch account|Save|^Retry$/ }),
    ).toBeNull();
    expect(h.request).toHaveBeenCalledTimes(reads);
    const retry = screen.getByRole("button", { name: "Use another account" });
    expect(retry).toHaveAttribute(
      "href",
      "https://staging.builderlab.example:8443/logout",
    );
    expect(retry).toHaveAttribute("target", "_blank");
    expect(retry).toHaveAttribute("rel", "noopener noreferrer");
    const credential = h.session.credential();
    const viewer = h.session.viewerSession();
    const releases = h.release.mock.calls.length;
    const attempts = h.acquire.mock.calls.length;
    const browser = observeLogout(h.session);
    try {
      if (activation === "pointer") await user.click(retry);
      else {
        retry.focus();
        await user.keyboard(activation === "Enter" ? "{Enter}" : " ");
      }
      expect(browser.opened).toEqual([
        {
          url: "https://staging.builderlab.example:8443/logout",
          status: "signed-out",
        },
      ]);
      expect(h.session.snapshot().status).toBe("signed-out");
      expect(() => h.session.credential()).toThrow();
      expect(() => h.session.viewerSession()).toThrow();
      expect(viewer.signal.aborted).toBe(true);
      expect(h.release).toHaveBeenCalledTimes(releases + 1);
      expect(h.release).toHaveBeenLastCalledWith(credential);
      expect(h.acquire).toHaveBeenCalledTimes(attempts);
      await user.click(screen.getByRole("button", { name: "Cancel sign-in" }));
      expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
      expect(
        screen.queryByRole("button", { name: "Use another account" }),
      ).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(
        screen.queryByRole("textbox", { name: "Instructions" }),
      ).toBeNull();
      h.prepareAccount({
        subject: "account-a",
        email: "a@example.com",
        canUseRemoteAgents: true,
      });
      await user.click(screen.getByRole("button", { name: "Retry" }));
      const restored = await loadedInstructions();
      expect(h.acquire).toHaveBeenCalledTimes(attempts + 1);
      expect(restored).toHaveValue("First instructions. Draft");
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    } finally {
      browser.stop();
    }
  },
);

it.each(["deadline", "cancel"] as const)(
  "shows a spinner after browser logout, then Retry on %s before checking the new account",
  async (finish) => {
    const h = await fixture(false);
    h.prepareAccount({
      subject: "wrong",
      email: "wrong@example.com",
      canUseRemoteAgents: false,
    });
    renderTabs(h);
    const recovery = await screen.findByRole("button", {
      name: "Use another account",
    });
    const browser = observeLogout(h.session);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      fireEvent.click(recovery);
      const spinner = screen.getByRole("button", { name: "Cancel sign-in" });
      expect(spinner).toHaveAttribute("aria-busy", "true");
      expect(spinner).toHaveAttribute("data-button-shape", "icon");
      expect(spinner.textContent).toBe("");
      expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
      expect(browser.opened).toEqual([
        { url: "https://builderlab.example/logout", status: "signed-out" },
      ]);
      await act(() => vi.advanceTimersByTimeAsync(2999));
      expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
      if (finish === "cancel") fireEvent.click(spinner);
      else await act(() => vi.advanceTimersByTimeAsync(1));
      const retry = screen.getByRole("button", { name: "Retry" });
      expect(retry).toBe(spinner);
      expect(retry).toBeEnabled();
      expect(h.acquire).toHaveBeenCalledOnce();
      expect(h.request).not.toHaveBeenCalled();
      vi.useRealTimers();
      h.prepareAccount({
        subject: "correct",
        email: "correct@example.com",
        canUseRemoteAgents: true,
      });
      const acquire = h.acquire.getMockImplementation();
      if (!acquire) throw new Error("Missing login fixture");
      const held = deferred<Awaited<ReturnType<typeof h.acquire>>>();
      h.acquire.mockReturnValueOnce(held.promise);
      fireEvent.click(retry);
      expect(screen.getByRole("button", { name: "Cancel sign-in" })).toBe(
        retry,
      );
      expect(h.acquire).toHaveBeenCalledTimes(2);
      await act(async () => held.resolve(await acquire()));
      await screen.findByRole("textbox", { name: "Instructions" });
      expect(await loadedInstructions()).toHaveValue("First instructions.");
      expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
      act(() => h.session.signOut());
      expect(
        screen.getByRole("button", { name: "Sign in to Builderlab" }),
      ).toBeEnabled();
    } finally {
      browser.stop();
      h.session.dispose();
    }
  },
);

it("recovers an unloaded no-access account through logout and normal sign-in, retaining ordinary Retry", async () => {
  const h = await fixture(false);
  h.prepareAccount({
    subject: "account-b",
    email: "b@example.com",
    canUseRemoteAgents: false,
  });
  render(<h.Tab agent={agent()} save={vi.fn()} />);
  await act(() => h.session.signIn());
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "This account can’t access Builderlab agents.",
  );
  expect(screen.queryByText(/coming soon/)).toBeNull();
  expect(screen.getByRole("alert")).not.toHaveTextContent(
    /used for this agent|set up|created/,
  );
  expect(
    screen.queryByRole("button", { name: /^Retry$|Switch account|Save/ }),
  ).toBeNull();
  expect(screen.getByRole("button", { name: /^Model:/ })).toBeDisabled();
  expect(screen.getByRole("combobox", { name: "Thinking" })).toBeDisabled();
  expect(screen.getByRole("textbox", { name: "Instructions" })).toBeDisabled();
  expect(h.request).not.toHaveBeenCalled();
  const user = userEvent.setup();
  const browser = observeLogout(h.session);
  try {
    await user.click(
      screen.getByRole("button", { name: "Use another account" }),
    );
    expect(browser.opened).toEqual([
      { url: "https://builderlab.example/logout", status: "signed-out" },
    ]);
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(() => h.session.credential()).toThrow();
    expect(h.acquire).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Cancel sign-in" }));
    expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
    // Returning the same browser account still offers recovery.
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(h.acquire).toHaveBeenCalledTimes(2);
    await user.click(
      await screen.findByRole("button", { name: "Use another account" }),
    );
    expect(browser.opened).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "Cancel sign-in" }));
    expect(h.request).not.toHaveBeenCalled();
    const held = deferred<ReturnType<typeof h.session.credential>>();
    h.acquire.mockImplementationOnce(() => held.promise);
    h.request.mockResolvedValueOnce({ ...response(), status: 400 });
    try {
      await user.click(screen.getByRole("button", { name: "Retry" }));
      expect(h.acquire).toHaveBeenCalledTimes(3);
      expect(
        screen.getByRole("button", { name: "Cancel sign-in" }),
      ).toHaveAttribute("aria-busy", "true");
      expect(h.session.snapshot().status).toBe("pending");
      expect(screen.queryByRole("alert")).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Use another account" }),
      ).toBeNull();
    } finally {
      await act(async () =>
        held.resolve({
          value: "credential-a",
          account: {
            subject: "account-a",
            email: "a@example.com",
            canUseRemoteAgents: true,
            canUseBuilderlabDecisions: false,
          },
        }),
      );
    }
    expect(await screen.findByRole("alert")).toHaveTextContent("HTTP 400");
    expect(
      screen.queryByRole("button", { name: "Use another account" }),
    ).toBeNull();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(h.acquire).toHaveBeenCalledTimes(3);
    expect(await loadedInstructions()).toHaveValue("First instructions.");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Use another account" }),
    ).toBeNull();
    expect(h.request).toHaveBeenCalledTimes(3);
  } finally {
    browser.stop();
  }
});

it("offers account recovery instead of Retry when settings return HTTP 403", async () => {
  const h = await fixture();
  h.request.mockResolvedValueOnce({ status: 403, headers: {}, body: "{}" });
  render(<h.Tab agent={agent()} save={vi.fn()} />);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "This Builderlab account cannot manage remote agents.",
  );
  const action = screen.getByRole("button", { name: "Use another account" });
  expect(action).toHaveAttribute("href", "https://builderlab.example/logout");
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  expect(h.request).toHaveBeenCalledOnce();
  const browser = observeLogout(h.session);
  try {
    const user = userEvent.setup();
    await user.click(action);
    expect(browser.opened).toEqual([
      { url: "https://builderlab.example/logout", status: "signed-out" },
    ]);
    await user.click(screen.getByRole("button", { name: "Cancel sign-in" }));
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await loadedInstructions()).toHaveValue("First instructions.");
    expect(screen.queryByRole("alert")).toBeNull();
  } finally {
    browser.stop();
    h.session.dispose();
  }
});

it("retries an agent missing from the list without ending the account session", async () => {
  const h = await fixture();
  const missing = {
    status: 200,
    headers: {},
    body: '{"status":1,"agents":[]}',
  };
  h.request.mockResolvedValueOnce(missing).mockResolvedValueOnce(missing);
  renderTabs(h);
  const user = userEvent.setup();
  try {
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Agent not found in this Builderlab account.",
    );
    expect(
      screen.queryByRole("button", { name: "Use another account" }),
    ).toBeNull();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(h.request).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Agent not found in this Builderlab account.",
    );
    expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
    expect(h.session.snapshot().status).toBe("signed-in");
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await loadedInstructions()).toHaveValue("First instructions.");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(h.acquire).toHaveBeenCalledOnce();
    expect(h.release).not.toHaveBeenCalled();
  } finally {
    h.session.dispose();
  }
});

it("retries a failed load and refuses to save a draft through another account", async () => {
  const h = await fixture();
  const user = userEvent.setup();
  h.request.mockResolvedValueOnce({ ...response(), status: 400 });
  renderTabs(h);
  expect(await screen.findByRole("alert")).toHaveTextContent("HTTP 400");
  expect(
    screen.getByRole("button", { name: "Change harness from Builderlab" }),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "Model: —" })).toBeDisabled();
  expect(screen.getByRole("combobox", { name: "Thinking" })).toBeDisabled();
  expect(screen.getByRole("combobox", { name: "Thinking" })).toHaveTextContent(
    "—",
  );
  expect(screen.getByRole("textbox", { name: "Instructions" })).toBeDisabled();
  expect(
    screen.getByRole("textbox", { name: "Instructions" }),
  ).not.toHaveAttribute("placeholder");
  expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Retry" }));
  let field = await loadedInstructions();
  expect(field).toHaveValue("First instructions.");
  await user.type(field, "Changed.");
  await act(async () => h.changeAccount());
  field = screen.getByRole("textbox", { name: "Instructions" });
  const before = h.request.mock.calls.length;
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Sign in as a@example.com to edit this agent.",
  );
  expect(field).toBeDisabled();
  expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  const form = field.closest("form");
  if (!form) throw new Error("Missing settings form");
  fireEvent.submit(form);
  expect(h.request).toHaveBeenCalledTimes(before);
  expect(field).toHaveValue("First instructions.Changed.");
});
it("settles an aborted catalog read after switching accounts without losing the draft", async () => {
  const h = await fixture();
  const held = deferred<HostResponse>();
  const request = h.request.getMockImplementation();
  if (!request) throw new Error("Missing request fixture");
  const catalog = vi.spyOn(h.client, "modelCatalog");
  h.request.mockImplementation((input) => {
    if (input.url.endsWith("/get-model-catalog")) {
      return held.promise;
    }
    return request(input);
  });
  render(<h.Tab agent={agent()} save={vi.fn()} />, { wrapper: StrictMode });
  try {
    let field = await loadedInstructions();
    await waitFor(() => expect(catalog).toHaveBeenCalled());
    expect(field.closest("[aria-busy]")).toHaveAttribute("aria-busy", "true");
    const user = userEvent.setup();
    await user.type(field, " Draft");
    act(() => h.session.signOut());
    expect(catalog.mock.calls.at(-1)?.[0].aborted).toBe(true);
    await act(() => h.changeAccount());
    field = screen.getByRole("textbox", { name: "Instructions" });
    await waitFor(() =>
      expect(field.closest("[aria-busy]")).toHaveAttribute(
        "aria-busy",
        "false",
      ),
    );
    expect(screen.getByRole("button", { name: "Model: —" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Retry models" })).toBeNull();
    const before = h.request.mock.calls.length;
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Sign in as a@example.com to edit this agent.",
    );
    expect(field).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    const form = field.closest("form");
    if (!form) throw new Error("Missing settings form");
    fireEvent.submit(form);
    expect(h.request).toHaveBeenCalledTimes(before);
    expect(field).toHaveValue("First instructions. Draft");
  } finally {
    await act(async () => {
      held.resolve({ status: 200, headers: {}, body: '{"models":[]}' });
    });
  }
  expect(
    screen.queryByText(
      "No models are available. Retry when the catalog is available.",
    ),
  ).toBeNull();
  expect(screen.getByRole("textbox", { name: "Instructions" })).toHaveValue(
    "First instructions. Draft",
  );
});
it("switching agents hides the old draft and ignores the switched-away read", async () => {
  const h = await fixture();
  const user = userEvent.setup();
  const mounted = render(<h.Tab agent={agent()} save={vi.fn()} />, {
    wrapper: StrictMode,
  });
  const field = await loadedInstructions();
  await user.type(field, "Unsaved.");
  const delayed = deferred<HostResponse>();
  h.request.mockReturnValueOnce(delayed.promise);
  try {
    mounted.rerender(<h.Tab agent={agent(second)} save={vi.fn()} />);
    await waitFor(() =>
      expect(
        h.request.mock.calls.filter(([request]) =>
          request.url.endsWith("/list-agents"),
        ),
      ).toHaveLength(2),
    );
    expect(
      screen.getByRole("textbox", { name: "Instructions" }),
    ).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Instructions" })).toHaveValue(
      "",
    );
    mounted.rerender(<h.Tab agent={agent()} save={vi.fn()} />);
    expect(await loadedInstructions()).toHaveValue("First instructions.");
  } finally {
    await act(async () => {
      delayed.resolve(response());
      await delayed.promise;
    });
  }
  expect(screen.getByRole("textbox", { name: "Instructions" })).toHaveValue(
    "First instructions.",
  );
});

function renderTabs(
  h: Awaited<ReturnType<typeof fixture>>,
  close?: () => void,
  initialActivity = false,
) {
  function Pane() {
    const agents = { save: vi.fn() } as unknown as Agents;
    const settings = useAgentSettingsHost({
      agents,
      agent: agent(),
      type: h.type,
      types: [
        h.type,
        {
          defaults: () => ({ config: {} }),
          pluginId: "local",
          revision: "1",
          key: "local/codex",
          id: "codex",
          title: "Codex",
        },
      ],
    });
    const [target, setTarget] = useState<HTMLDivElement | null>(null);
    return (
      <AgentSaveFooter value={{ target }}>
        <AgentTabs
          initialActivity={initialActivity}
          agents={agents}
          agent={agent()}
          type={h.type}
          channels={[]}
          memories={undefined}
          settingsHost={settings.settingsHost}
          settingsContent={<p>Agent settings</p>}
        />
        <div ref={setTarget} data-testid="save-footer" />
      </AgentSaveFooter>
    );
  }
  render(
    close ? (
      <PanelCard
        target="agent:test"
        close={close}
        panel={{
          id: "agent",
          key: "test/agent",
          pluginId: "test",
          revision: "test",
          title: "Agent",
          matches: () => true,
          component: Pane,
        }}
      />
    ) : (
      <Pane />
    ),
    { wrapper: StrictMode },
  );
}

it("opens Activity without login and keeps Identity's login running after leaving it", async () => {
  const h = await fixture(false);
  const acquire = h.acquire.getMockImplementation();
  if (!acquire) throw new Error("Missing sign-in fixture");
  const held = deferred<Awaited<ReturnType<typeof h.acquire>>>();
  h.acquire.mockReturnValueOnce(held.promise);
  const signIn = vi.spyOn(h.session, "signIn");
  renderTabs(h, undefined, true);
  expect(h.acquire).not.toHaveBeenCalled();
  expect(h.request).not.toHaveBeenCalled();
  const user = userEvent.setup();
  await user.click(screen.getByRole("tab", { name: "Identity" }));
  expect(h.acquire).toHaveBeenCalledOnce();
  await user.click(screen.getByRole("tab", { name: "Activity" }));
  expect(h.session.snapshot().status).toBe("pending");
  await act(async () => {
    held.resolve(await acquire());
    await signIn.mock.results[0]?.value;
  });
  expect(h.session.snapshot().status).toBe("signed-in");
  expect(h.request).not.toHaveBeenCalled();
  expect(screen.queryByRole("textbox", { name: "Instructions" })).toBeNull();
  await user.click(screen.getByRole("tab", { name: "Identity" }));
  expect(await loadedInstructions()).toHaveValue("First instructions.");
  expect(h.acquire).toHaveBeenCalledOnce();
  h.session.dispose();
});

it("dismisses Harness help before allowing Escape to close the agent pane", async () => {
  const h = await fixture();
  const user = userEvent.setup();
  const close = vi.fn();
  renderTabs(h, close);
  const harness = await screen.findByRole("button", {
    name: "Change harness from Builderlab",
  });
  const selectedMask = harness.querySelector("mask");
  expect(selectedMask).not.toBeNull();
  await user.click(harness);
  const option = await screen.findByRole("menuitemradio", {
    name: "Builderlab",
  });
  expect(option).toBeChecked();
  const optionMask = option.querySelector("mask");
  expect(optionMask).not.toBeNull();
  expect(optionMask?.id).not.toBe(selectedMask?.id);
  await screen.findByRole("menuitemradio", { name: "Codex" });
  await user.keyboard("{End}{Enter}");
  expect(
    await screen.findByRole("dialog", { name: "Harness availability" }),
  ).toBeVisible();
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "Harness availability" }),
    ).toBeNull(),
  );
  expect(screen.getByRole("complementary", { name: "Agent" })).toBeVisible();
  expect(screen.getByRole("menuitemradio", { name: "Codex" })).toHaveFocus();
  expect(close).not.toHaveBeenCalled();
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  expect(harness).toHaveFocus();
  expect(close).not.toHaveBeenCalled();
  await user.keyboard("{Escape}");
  expect(close).toHaveBeenCalledOnce();
});

it("shows the remote execution hint only while the shared account is signed in", async () => {
  const h = await fixture(false);
  const held = deferred<Awaited<ReturnType<typeof h.acquire>>>();
  h.acquire.mockReturnValueOnce(held.promise);
  const signIn = vi.spyOn(h.session, "signIn");
  renderTabs(h);
  expect(screen.queryByRole("note")).not.toBeInTheDocument();
  expect(h.request).not.toHaveBeenCalled();
  try {
    expect(h.session.snapshot().status).toBe("pending");
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  } finally {
    await act(async () => {
      held.resolve({
        value: "credential",
        account: {
          subject: "account-a",
          email: "a@example.com",
          canUseRemoteAgents: true,
          canUseBuilderlabDecisions: false,
        },
      });
      await signIn.mock.results[0]?.value;
    });
  }
  await loadedInstructions();
  const note = screen.getByRole("note");
  expect(within(note).getByText("Remote agent")).toBeVisible();
  expect(within(note).getByText("Runs on a Builderlab machine")).toBeVisible();
  expect(note).not.toHaveTextContent("It can’t open files on this computer.");
  act(() => h.session.signOut());
  expect(screen.queryByRole("note")).not.toBeInTheDocument();
});

it("hides the runtime Workspace hint while signed out without loading settings", async () => {
  const h = await fixture(false);
  render(<h.Tab agent={agent()} save={vi.fn()} settingsSection="runtime" />, {
    wrapper: StrictMode,
  });
  expect(screen.queryByText("Workspace")).not.toBeInTheDocument();
  await act(async () => {
    await h.session.signIn();
  });
  expect(screen.getByText("Workspace")).toBeVisible();
  expect(
    screen.getByText(
      /shared with your other agents in this workspace by default/,
    ),
  ).toBeVisible();
  expect(screen.getByText(/you can chat from your phone/)).toBeVisible();
  act(() => h.session.signOut());
  expect(
    screen.queryByText(/you can chat from your phone/),
  ).not.toBeInTheDocument();
  expect(screen.queryByText("Workspace")).not.toBeInTheDocument();
  expect(
    screen.queryByText(
      /shared with your other agents in this workspace by default/,
    ),
  ).not.toBeInTheDocument();
  expect(h.request).not.toHaveBeenCalled();
});

it("keeps hosted instructions on cancellation and resets a confirmed discard", async () => {
  const h = await fixture();
  const user = userEvent.setup();
  renderTabs(h);
  const identity = screen.getByRole("tabpanel", { name: "Identity" });
  const note = within(identity).getByRole("note");
  expect(within(note).getByText("Remote agent")).toBeVisible();
  expect(within(note).getByText("Runs on a Builderlab machine")).toBeVisible();
  const harness = within(identity).getByRole("button", {
    name: "Change harness from Builderlab",
  });
  const container = harness.closest(".buzz-settings-group");
  if (!container) throw new Error("Harness settings container is missing");
  expect(container).not.toContainElement(note);
  expect(
    note.compareDocumentPosition(container) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(screen.queryByRole("tab", { name: "Instructions" })).toBeNull();
  expect(screen.getByRole("tab", { name: "Identity" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const field = await loadedInstructions();
  expect(await screen.findByRole("button", { name: /^Model:/ })).toBeVisible();
  expect(screen.getByRole("combobox", { name: "Thinking" })).toBeVisible();
  expect(screen.queryByText("Workspace")).toBeNull();
  expect(screen.queryByRole("link", { name: "Builderlab" })).toBeNull();
  await user.type(field, " Unsaved.");
  await user.click(screen.getByRole("tab", { name: "Settings" }));
  expect(await screen.findByRole("alertdialog")).toHaveTextContent(
    "Discard changes?",
  );
  await user.click(screen.getByRole("button", { name: "Keep editing" }));
  expect(field).toHaveValue("First instructions. Unsaved.");
  const save = screen.getByRole("button", { name: "Save" });
  const pending = deferred<HostResponse>();
  h.request.mockReturnValueOnce(pending.promise);
  try {
    await user.click(save);
    expect(field).toBeDisabled();
    expect(screen.getByRole("tab", { name: "Settings" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await user.click(screen.getByRole("tab", { name: "Settings" }));
    expect(screen.getByRole("textbox", { name: "Instructions" })).toBe(field);
  } finally {
    await act(async () => pending.reject(new Error("offline")));
  }
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Could not reach Builderlab",
  );
  await user.click(screen.getByRole("tab", { name: "Settings" }));
  await user.click(screen.getByRole("button", { name: "Keep editing" }));
  expect(field).toHaveValue("First instructions. Unsaved.");
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Could not reach Builderlab",
  );
  expect(save).toBeEnabled();
  await user.click(screen.getByRole("tab", { name: "Settings" }));
  await user.click(screen.getByRole("button", { name: "Discard changes" }));
  expect(screen.queryByRole("textbox", { name: "Instructions" })).toBeNull();
  expect(screen.getByText("Workspace")).toBeVisible();
  expect(screen.getByText("One session per thread")).toBeVisible();
  expect(screen.getByText("Agent settings")).toBeVisible();
  expect(screen.queryByRole("note")).not.toBeInTheDocument();
  const runtime = screen.getByRole("link", { name: "Builderlab" });
  expect(runtime).toHaveAttribute("href", "https://builderlab.example");
  expect(runtime.closest(".buzz-preference-row-description")).toHaveTextContent(
    "Hosted and managed by Builderlab.",
  );
  expect(runtime.closest(".buzz-settings-group")).toHaveTextContent("Runtime");
  expect(runtime.closest(".buzz-settings-group")).toHaveTextContent(
    "Workspace",
  );
  expect(runtime.closest(".buzz-settings-group")).toHaveTextContent("Sessions");
  expect(screen.queryByRole("button", { name: /^Model:/ })).toBeNull();
  expect(screen.queryByRole("combobox", { name: "Thinking" })).toBeNull();
  await user.click(screen.getByRole("tab", { name: "Identity" }));
  const fresh = await loadedInstructions();
  expect(fresh).not.toBe(field);
  expect(fresh).toHaveValue("First instructions.");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByText("Workspace")).toBeNull();
  expect(await screen.findByRole("button", { name: /^Model:/ })).toBeVisible();
});

it("guards hosted model drafts and a pending model save", async () => {
  const h = await fixture();
  const user = userEvent.setup();
  renderTabs(h);
  await loadedInstructions();
  const modelTrigger = await screen.findByRole("button", { name: /^Model:/ });
  await waitFor(() => expect(modelTrigger).toBeEnabled());
  await user.click(modelTrigger);
  (await screen.findByRole("menuitem", { name: "Other" })).focus();
  await user.keyboard("{ArrowRight}");
  await user.click(
    await screen.findByRole("menuitemradio", { name: "Friendly Model" }),
  );
  expect(
    screen.queryByRole("button", { name: "Save" }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("tab", { name: "Settings" }));
  expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Keep editing" }));
  expect(screen.getByRole("button", { name: /^Model:/ })).toHaveTextContent(
    "Friendly Model",
  );
  await user.click(screen.getByRole("combobox", { name: "Thinking" }));
  await user.click(await screen.findByRole("option", { name: "High" }));
  const pending = deferred<HostResponse>();
  h.request.mockReturnValueOnce(pending.promise);
  try {
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("tab", { name: "Settings" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await user.click(screen.getByRole("tab", { name: "Settings" }));
    expect(screen.getByRole("button", { name: /^Model:/ })).toBeVisible();
  } finally {
    await act(async () => pending.reject(new Error("offline")));
  }
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Could not reach Builderlab",
  );
  await user.click(screen.getByRole("tab", { name: "Settings" }));
  await user.click(screen.getByRole("button", { name: "Discard changes" }));
  expect(screen.getByText("Agent settings")).toBeVisible();
  expect(screen.queryByRole("button", { name: /^Model:/ })).toBeNull();
  await user.click(screen.getByRole("tab", { name: "Identity" }));
  expect(await loadedInstructions()).toHaveValue("First instructions.");
  expect(
    await screen.findByRole("button", { name: /^Model:/ }),
  ).toHaveTextContent("Choose a model");
  expect(screen.getByRole("combobox", { name: "Thinking" })).toHaveTextContent(
    "Choose thinking",
  );
  expect(screen.queryByRole("alert")).toBeNull();
});

it("saves model and instructions together through one footer action", async () => {
  const h = await fixture();
  const user = userEvent.setup();
  renderTabs(h);
  const field = await loadedInstructions();
  expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  const modelTrigger = await screen.findByRole("button", { name: /^Model:/ });
  await waitFor(() => expect(modelTrigger).toBeEnabled());
  await user.click(modelTrigger);
  (await screen.findByRole("menuitem", { name: "Other" })).focus();
  await user.keyboard("{ArrowRight}");
  await user.click(
    await screen.findByRole("menuitemradio", { name: "Friendly Model" }),
  );
  await user.type(field, " Updated.");
  // A partial model draft cannot be silently skipped by Save.
  expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  await user.click(screen.getByRole("combobox", { name: "Thinking" }));
  await user.click(await screen.findByRole("option", { name: "High" }));
  const save = screen.getByRole("button", { name: "Save" });
  expect(screen.getByTestId("save-footer")).toContainElement(save);
  expect(save).toHaveAttribute("form", field.closest("form")?.id);
  await user.click(save);
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull(),
  );
  const updates = h.request.mock.calls.filter(([request]) =>
    request.url.endsWith("/update-agent"),
  );
  expect(updates).toHaveLength(1);
  expect(JSON.parse(updates[0]?.[0].body ?? "{}")).toEqual({
    agent_pubkey: first,
    agent_instructions: "First instructions. Updated.",
    model_id: "one",
    reasoning_effort: "high",
  });
  expect(field).toHaveValue("First instructions. Updated.");
  expect(modelTrigger).toHaveTextContent("Friendly Model");
  await user.click(screen.getByRole("tab", { name: "Settings" }));
  expect(screen.getByText("Agent settings")).toBeVisible();
  expect(screen.queryByRole("alertdialog")).toBeNull();
});

it("keeps runtime settings available without loading Builderlab configuration", async () => {
  const h = await fixture();
  render(
    <h.Tab
      agent={agent()}
      save={vi.fn()}
      settingsSection="runtime"
      settingsContent={<p>Agent settings</p>}
    />,
    { wrapper: StrictMode },
  );
  expect(screen.getByText("Workspace")).toBeVisible();
  expect(screen.getByText("One session per thread")).toBeVisible();
  expect(screen.getByText("Agent settings")).toBeVisible();
  expect(screen.queryByRole("textbox", { name: "Instructions" })).toBeNull();
  expect(screen.queryByRole("button", { name: /^Model:/ })).toBeNull();
  expect(h.request).not.toHaveBeenCalled();
});
