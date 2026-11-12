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
import { StrictMode, useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Host, HostResponse } from "../../../features/host/service";
import { createAgentClient } from "../agents/client";
import type { Credential } from "../session";
import { deferred, createTestSession } from "../test-helpers";
import {
  createCreationAction,
  createCreationFields,
  EMPTY_CREATION,
} from "./Create";

beforeEach(() =>
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example"),
);
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  delete document.documentElement.dataset.keyboardNavigation;
});
const catalog = [
  {
    id: "one",
    display_name: "Sol 6.1",
    supported_reasoning_efforts: ["low", "high", "xhigh"],
  },
  {
    id: "two",
    display_name: "Model Two",
    supported_reasoning_efforts: ["none"],
  },
];
async function fixture(signedIn = true, recommended?: unknown) {
  const acquire = vi.fn(async () => ({
    revision: "credential",
    account: {
      subject: "account",
      email: "a@example.com",
      canUseRemoteAgents: true,
      canUseBuilderlabDecisions: false,
    },
  }));
  const session = createTestSession(acquire, undefined, {
    request: (input) => request(input),
  });
  if (signedIn) await session.signIn();
  let fail = false;
  const pending = deferred<void>();
  const request = vi.fn<Host["request"]>(async () => {
    await pending.promise;
    if (fail) return { status: 400, headers: {}, body: "{}" };
    return {
      status: 200,
      headers: {},
      body: JSON.stringify({
        models: catalog,
        recommended_selection: recommended,
      }),
    };
  });
  const client = createAgentClient(session, null);
  const { Create, CreateConfiguration } = createCreationFields(client, session);
  const submit = vi.fn();
  const ready = vi.fn();
  const Action = createCreationAction(session);
  let draft = { ...EMPTY_CREATION };
  function Form() {
    const [config, setConfig] = useState(draft);
    draft = config;
    return (
      <form
        aria-label="New Builderlab agent"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <Action disabled={false} />
        <CreateConfiguration
          config={config}
          onChange={setConfig}
          disabled={false}
          harnessControl={null}
          onReadyChange={ready}
        />
        <Create config={config} onChange={setConfig} disabled={false} />
        <button type="submit">Create agent</button>
      </form>
    );
  }
  render(<Form />, { wrapper: StrictMode });
  return {
    session,
    acquire,
    request,
    pending,
    submit,
    ready,
    draft: () => draft,
    fail: (value: boolean) => {
      fail = value;
    },
  };
}
async function choose(label: string, value: string) {
  const user = userEvent.setup();
  if (label === "Model") {
    await user.click(await screen.findByRole("button", { name: /^Model:/ }));
    (
      await screen.findByRole("menuitem", {
        name: value.startsWith("Sol") ? "OpenAI" : "Other",
      })
    ).focus();
    await user.keyboard("{ArrowRight}");
    await user.click(await screen.findByRole("menuitemradio", { name: value }));
    return;
  }
  await user.click(await screen.findByRole("combobox", { name: label }));
  await user.click(await screen.findByRole("option", { name: value }));
}

it("keeps the native missing-model message and forwards input focus to Model", async () => {
  const h = await fixture();
  await act(async () => h.pending.resolve());
  const model = await screen.findByRole("button", {
    name: "Model: Choose a model",
  });
  const form = screen.getByRole("form", {
    name: "New Builderlab agent",
  }) as HTMLFormElement;
  const input = form.elements.namedItem("builderlab-model") as HTMLInputElement;
  const invalid = vi.fn<(event: Event) => void>();
  input.addEventListener("invalid", invalid);
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Create agent" }));
  expect(h.submit).not.toHaveBeenCalled();
  expect(invalid).toHaveBeenCalledOnce();
  expect(invalid.mock.calls[0]?.[0].defaultPrevented).toBe(false);
  expect(input.validity.valueMissing).toBe(true);
  const message = input.validationMessage;
  expect(message).not.toBe("");
  // jsdom dispatches invalid but does not perform the browser's native focus step.
  delete document.documentElement.dataset.keyboardNavigation;
  input.focus();
  expect(model).toHaveFocus();
  expect(document.documentElement).toHaveAttribute("data-keyboard-navigation");
  await choose("Model", "Sol 6.1");
  expect(input.validationMessage).toBe("");
  expect(
    (form.elements.namedItem("builderlab-effort") as HTMLInputElement)
      .validationMessage,
  ).toBe(message);
  expect(form.checkValidity()).toBe(false);
  await choose("Thinking", "High");
  expect(form.checkValidity()).toBe(true);
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Create agent" }));
  expect(h.submit).toHaveBeenCalledOnce();
});

it.each([
  [
    "https://builderlab.example",
    "builderlab.example",
    "https://builderlab.example/",
  ],
  [
    "https://login.example/deployment/",
    "login.example/deployment",
    "https://login.example/deployment/",
  ],
])(
  "says the agent runs on the Builderlab account and links %s's site",
  async (server, name, href) => {
    vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", server);
    await fixture(false);
    expect(
      screen.getByText(
        /Runs on your Builderlab account\. Usage and billing are at/,
      ),
    ).toBeInTheDocument();
    const link = screen.getByRole("link", { name });
    expect(link).toHaveAttribute("href", href);
    expect(link).toHaveAttribute("target", "_blank");
  },
);

it("shows the instruction limit as accessible field help", async () => {
  await fixture(false);
  const instructions = screen.getByRole("textbox", {
    name: "Instructions Optional",
  });
  expect(screen.getByText("Up to 20,000 characters.")).toBeVisible();
  expect(instructions).toHaveAccessibleDescription("Up to 20,000 characters.");
});

it("loads the catalog and keeps instructions alongside explicit model and effort choices", async () => {
  const h = await fixture();
  expect(h.ready).toHaveBeenLastCalledWith(false);
  expect(screen.getByRole("status")).toHaveTextContent("Loading models");
  await act(async () => h.pending.resolve());
  const model = await screen.findByRole("button", {
    name: "Model: Choose a model",
  });
  expect(model).toHaveTextContent("Choose a model");
  expect(screen.getByRole("combobox", { name: "Thinking" })).toBeDisabled();
  await userEvent
    .setup()
    .type(
      screen.getByRole("textbox", { name: "Instructions Optional" }),
      "Be precise.",
    );
  await choose("Model", "Sol 6.1");
  await choose("Thinking", "Extra high");
  expect(h.draft().reasoningEffort).toBe("xhigh");
  expect(h.ready).toHaveBeenLastCalledWith(true);
  await choose("Model", "Model Two");
  expect(h.draft().reasoningEffort).toBe("");
  expect(h.ready).toHaveBeenLastCalledWith(false);
  expect(
    screen.getByRole("textbox", { name: "Instructions Optional" }),
  ).toHaveValue("Be precise.");
  await choose("Thinking", "None");
  expect(h.draft()).toEqual({
    instructions: "Be precise.",
    modelId: "two",
    reasoningEffort: "none",
    subject: "account",
  });
  expect(
    h.request.mock.calls.every(([input]) =>
      input.url.endsWith("/get-model-catalog"),
    ),
  ).toBe(true);
});

it("preselects Builderlab's recommendation and keeps the person's later choice", async () => {
  const h = await fixture(true, { model_id: "one", reasoning_effort: "high" });
  await act(async () => h.pending.resolve());
  await screen.findByRole("button", { name: "Model: Sol 6.1" });
  expect(screen.getByRole("combobox", { name: "Thinking" })).toHaveTextContent(
    "High",
  );
  expect(h.draft()).toEqual({
    instructions: "",
    modelId: "one",
    reasoningEffort: "high",
    subject: "account",
  });
  // Untouched recommended choices are complete, so creation is ready.
  expect(h.ready).toHaveBeenLastCalledWith(true);
  await choose("Model", "Model Two");
  await choose("Thinking", "None");
  // A reloaded catalog recommends again, but only into untouched choices.
  act(() => h.session.signOut());
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Sign in to Builderlab" }));
  await screen.findByRole("button", { name: "Model: Model Two" });
  expect(h.draft()).toEqual({
    instructions: "",
    modelId: "two",
    reasoningEffort: "none",
    subject: "account",
  });
});

it("moves an untouched recommendation to a newly signed-in account", async () => {
  const h = await fixture(true, { model_id: "one", reasoning_effort: "high" });
  await act(async () => h.pending.resolve());
  await screen.findByRole("button", { name: "Model: Sol 6.1" });
  act(() => h.session.signOut());
  h.acquire.mockResolvedValue({
    revision: "other-credential",
    account: {
      subject: "other",
      email: "b@example.com",
      canUseRemoteAgents: true,
      canUseBuilderlabDecisions: false,
    },
  });
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Sign in to Builderlab" }));
  await screen.findByRole("button", { name: "Model: Sol 6.1" });
  expect(h.draft()).toEqual({
    instructions: "",
    modelId: "one",
    reasoningEffort: "high",
    subject: "other",
  });
  expect(screen.queryByText(/another Builderlab account/)).toBeNull();
  expect(h.ready).toHaveBeenLastCalledWith(true);
  expect(screen.getByRole("combobox", { name: "Thinking" })).toBeEnabled();
});

it.each([
  { field: "Thinking", recommendation: "changed" },
  { field: "Thinking", recommendation: "missing" },
  { field: "Model", recommendation: "changed" },
  { field: "Model", recommendation: "missing" },
])(
  "preserves an explicit $field choice that returns to the suggestion before an account switch with a $recommendation recommendation",
  async ({ field, recommendation }) => {
    const h = await fixture(true, {
      model_id: "one",
      reasoning_effort: "high",
    });
    await act(async () => h.pending.resolve());
    await screen.findByRole("button", { name: "Model: Sol 6.1" });
    if (field === "Model") {
      await choose("Model", "Model Two");
      await choose("Thinking", "None");
      await choose("Model", "Sol 6.1");
    } else {
      await choose("Thinking", "Low");
    }
    await choose("Thinking", "High");
    const explicit = { ...h.draft() };
    expect(explicit).toMatchObject({
      modelId: "one",
      reasoningEffort: "high",
      subject: "account",
    });
    act(() => h.session.signOut());
    h.acquire.mockResolvedValue({
      revision: "other-credential",
      account: {
        subject: "other",
        email: "b@example.com",
        canUseRemoteAgents: true,
        canUseBuilderlabDecisions: false,
      },
    });
    h.request.mockResolvedValue({
      status: 200,
      headers: {},
      body: JSON.stringify({
        models: catalog,
        recommended_selection:
          recommendation === "changed"
            ? { model_id: "two", reasoning_effort: "none" }
            : undefined,
      }),
    });
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Sign in to Builderlab" }));
    const thinking = await screen.findByRole("combobox", { name: "Thinking" });
    expect(h.draft()).toEqual(explicit);
    expect(screen.getByText(/another Builderlab account/)).toBeVisible();
    expect(thinking).toBeDisabled();
    expect(h.ready).toHaveBeenLastCalledWith(false);
  },
);

it("retains instructions when catalog loading fails and is retried", async () => {
  const h = await fixture();
  h.fail(true);
  await userEvent
    .setup()
    .type(
      screen.getByRole("textbox", { name: "Instructions Optional" }),
      "Keep this.",
    );
  await act(async () => h.pending.resolve());
  const retry = await screen.findByRole("button", { name: "Retry models" });
  expect(screen.getByRole("alert")).toHaveTextContent("HTTP 400");
  h.fail(false);
  await userEvent.setup().click(retry);
  await screen.findByRole("button", { name: "Model: Choose a model" });
  expect(h.draft().instructions).toBe("Keep this.");
  expect(h.draft().modelId).toBe("");
});

it("offers catalog families without a default or custom model action", async () => {
  const h = await fixture();
  await act(async () => h.pending.resolve());
  await userEvent
    .setup()
    .click(
      await screen.findByRole("button", { name: "Model: Choose a model" }),
    );
  expect(await screen.findByRole("menuitem", { name: "OpenAI" })).toBeVisible();
  expect(screen.getByRole("menuitem", { name: "Other" })).toBeVisible();
  expect(screen.queryByText(/Default|Custom model/)).not.toBeInTheDocument();
  expect(h.draft()).toEqual(EMPTY_CREATION);
});

it("requires new account choices while retaining the draft instructions", async () => {
  const h = await fixture();
  await act(async () => h.pending.resolve());
  await choose("Model", "Sol 6.1");
  await choose("Thinking", "High");
  await userEvent
    .setup()
    .type(
      screen.getByRole("textbox", { name: "Instructions Optional" }),
      "Keep this.",
    );
  expect(h.ready).toHaveBeenLastCalledWith(true);
  act(() => h.session.signOut());
  expect(h.ready).toHaveBeenLastCalledWith(false);
  h.acquire.mockResolvedValue({
    revision: "other-credential",
    account: {
      subject: "other",
      email: "b@example.com",
      canUseRemoteAgents: true,
      canUseBuilderlabDecisions: false,
    },
  });
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Sign in to Builderlab" }));
  await screen.findByRole("button", { name: "Model: Sol 6.1" });
  expect(screen.getByRole("status")).toHaveTextContent(
    "another Builderlab account",
  );
  expect(h.ready).toHaveBeenLastCalledWith(false);
  expect(screen.getByRole("combobox", { name: "Thinking" })).toBeDisabled();
  await choose("Model", "Model Two");
  await choose("Thinking", "None");
  expect(h.draft()).toEqual({
    instructions: "Keep this.",
    modelId: "two",
    reasoningEffort: "none",
    subject: "other",
  });
});

it("withdraws readiness for invalid instructions or a failed catalog and restores it after retry", async () => {
  const h = await fixture();
  await act(async () => h.pending.resolve());
  await choose("Model", "Sol 6.1");
  await choose("Thinking", "High");
  expect(h.ready).toHaveBeenLastCalledWith(true);
  const instructions = screen.getByRole("textbox", {
    name: "Instructions Optional",
  });
  await userEvent.setup().type(instructions, "   ");
  expect(h.ready).toHaveBeenLastCalledWith(false);
  await userEvent.setup().clear(instructions);
  expect(h.ready).toHaveBeenLastCalledWith(true);
  h.fail(true);
  act(() => h.session.signOut());
  expect(h.ready).toHaveBeenLastCalledWith(false);
  await act(async () => {
    await h.session.signIn();
  });
  expect(await screen.findByRole("alert")).toHaveTextContent("HTTP 400");
  expect(h.ready).toHaveBeenLastCalledWith(false);
  h.fail(false);
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Retry models" }));
  await screen.findByRole("button", { name: "Model: Sol 6.1" });
  expect(h.ready).toHaveBeenLastCalledWith(true);
});

it("waits for the current login's catalog before restoring ready choices", async () => {
  const h = await fixture();
  await act(async () => h.pending.resolve());
  await choose("Model", "Sol 6.1");
  await choose("Thinking", "High");
  expect(h.ready).toHaveBeenLastCalledWith(true);
  const reload = deferred<HostResponse>();
  h.request.mockImplementationOnce(() => reload.promise);
  act(() => h.session.signOut());
  const before = h.ready.mock.calls.length;
  try {
    await act(async () => {
      await h.session.signIn();
    });
    expect(screen.getByRole("status")).toHaveTextContent("Loading models");
    expect(h.ready.mock.calls.slice(before).flat()).not.toContain(true);
    await act(async () =>
      reload.resolve({ status: 200, headers: {}, body: '{"models":[]}' }),
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "No models are available",
    );
    expect(h.ready).toHaveBeenLastCalledWith(false);
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Retry models" }));
    await screen.findByRole("button", { name: "Model: Sol 6.1" });
    expect(h.ready).toHaveBeenLastCalledWith(true);
  } finally {
    reload.resolve({ status: 200, headers: {}, body: '{"models":[]}' });
  }
});

it("waits for explicit sign-in before loading the creation catalog", async () => {
  const h = await fixture(false);
  expect(h.acquire).not.toHaveBeenCalled();
  expect(h.request).not.toHaveBeenCalled();
  expect(h.ready).toHaveBeenLastCalledWith(false);
  expect(
    screen.getByRole("button", { name: "Model: Choose a model" }),
  ).toBeDisabled();
  expect(screen.getByRole("combobox", { name: "Thinking" })).toBeDisabled();
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  const signIn = screen.getByRole("button", { name: "Sign in to Builderlab" });
  expect(signIn).toHaveAttribute("data-size", "sm");
  await act(async () => h.pending.resolve());
  await userEvent.setup().click(signIn);
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Model: Choose a model" }),
    ).toBeEnabled(),
  );
  expect(h.acquire).toHaveBeenCalledTimes(1);
  // Sign-in enables choices; creation still waits for a model and thinking level.
  expect(h.ready).toHaveBeenLastCalledWith(false);
  expect(
    screen.queryByRole("button", { name: "Sign in to Builderlab" }),
  ).not.toBeInTheDocument();
  await act(async () => h.session.signOut());
  expect(h.ready).toHaveBeenLastCalledWith(false);
  expect(
    screen.getByRole("button", { name: "Model: Choose a model" }),
  ).toBeDisabled();
  expect(screen.getByRole("combobox", { name: "Thinking" })).toBeDisabled();
});

it("shares the cancellable spinner without browser-return guidance", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const login = deferred<Credential>();
  let aborted = false;
  const session = createTestSession(
    (signal) => {
      signal.addEventListener("abort", () => (aborted = true));
      return login.promise;
    },
    undefined,
    { request: (input) => request(input) },
  );
  const request = vi.fn<Host["request"]>();
  const client = createAgentClient(session, null);
  const { CreateConfiguration } = createCreationFields(client, session);
  const Action = createCreationAction(session);
  render(
    <>
      <Action disabled />
      <CreateConfiguration
        config={{ ...EMPTY_CREATION }}
        disabled
        onChange={() => {}}
        harnessControl={null}
      />
    </>,
    { wrapper: StrictMode },
  );
  expect(
    screen.queryByRole("button", { name: "Cancel sign-in" }),
  ).not.toBeInTheDocument();
  let signingIn = Promise.resolve();
  await act(async () => {
    signingIn = session.signIn();
  });
  const progress = screen.getByRole("button", {
    name: "Cancel sign-in",
  });
  expect(progress).toHaveAttribute("aria-busy", "true");
  expect(progress).toHaveAttribute("data-button-shape", "icon");
  expect(
    progress.querySelector('[class~="motion-safe:animate-spin"]'),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Cancel sign-in" }),
  ).toBeInTheDocument();
  expect(progress).toBeEnabled();
  expect(aborted).toBe(false);
  expect(session.snapshot().status).toBe("pending");
  expect(
    screen.getByRole("button", { name: "Model: Choose a model" }),
  ).toBeDisabled();
  expect(screen.getByRole("combobox", { name: "Thinking" })).toBeDisabled();
  await act(() => vi.advanceTimersByTimeAsync(2999));
  expect(progress).toHaveAttribute("aria-busy", "true");
  expect(
    screen.queryByRole("button", { name: "Cancel sign-in" }),
  ).toBeInTheDocument();
  expect(screen.queryByText(/Finish signing in/)).not.toBeInTheDocument();
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(screen.queryByText(/Finish signing in/)).not.toBeInTheDocument();
  const cancel = screen.getByRole("button", { name: "Cancel sign-in" });
  expect(cancel).toBeEnabled();
  expect(
    cancel.querySelector('[class~="motion-safe:animate-spin"]'),
  ).toBeInTheDocument();
  fireEvent.click(cancel);
  expect(aborted).toBe(true);
  expect(session.snapshot().status).toBe("signed-out");
  expect(
    screen.queryByRole("button", { name: "Cancel sign-in" }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Sign in to Builderlab" }),
  ).toBeDisabled();
  expect(request).not.toHaveBeenCalled();
  expect(screen.queryByText(/Finish signing in/)).not.toBeInTheDocument();
  await act(async () => {
    login.resolve({
      revision: "late",
      account: {
        subject: "late",
        email: "late@example.com",
        canUseRemoteAgents: true,
        canUseBuilderlabDecisions: false,
      },
    });
    await signingIn;
  });
  expect(session.snapshot().status).toBe("signed-out");
});

it("keeps account verification non-cancellable beyond the browser deadline", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const session = createTestSession(vi.fn());
  const checking = { status: "pending" as const, checking: true };
  const cancel = vi.fn();
  const Action = createCreationAction({
    ...session,
    snapshot: () => checking,
    cancel,
  });
  render(<Action disabled={false} />);
  await act(() => vi.advanceTimersByTimeAsync(30_000));
  const progress = screen.getByRole("button", {
    name: "Sign in to Builderlab",
  });
  expect(progress).toHaveAttribute("aria-busy", "true");
  expect(
    screen.queryByRole("button", { name: "Cancel sign-in" }),
  ).not.toBeInTheDocument();
  fireEvent.click(progress);
  expect(cancel).not.toHaveBeenCalled();
});
