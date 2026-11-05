// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Host, HostResponse } from "../../../features/host/service";
import { createAgentClient } from "../agents/client";
import type { Credential } from "../session";
import { deferred, createTestSession } from "../test-helpers";
import { createCreationFields, EMPTY_CREATION } from "./Create";

beforeEach(() =>
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example"),
);
afterEach(() => {
  cleanup();
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
async function fixture(signedIn = true) {
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
      body: JSON.stringify({ models: catalog }),
    };
  });
  const client = createAgentClient(session, null);
  const { Create, CreateConfiguration } = createCreationFields(client, session);
  const submit = vi.fn();
  const ready = vi.fn();
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
    .click(screen.getByRole("button", { name: "Sign in with Builderlab" }));
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
  await act(async () => h.pending.resolve());
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Sign in with Builderlab" }));
  await screen.findByRole("button", { name: "Model: Choose a model" });
  expect(h.acquire).toHaveBeenCalledTimes(1);
});

it("can cancel a pending shared sign-in even while the creation form is disabled", async () => {
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
  render(
    <CreateConfiguration
      config={{ ...EMPTY_CREATION }}
      disabled
      onChange={() => {}}
      harnessControl={null}
    />,
    { wrapper: StrictMode },
  );
  expect(
    screen.queryByRole("button", { name: "Cancel sign-in" }),
  ).not.toBeInTheDocument();
  await act(async () => {
    void session.signIn();
  });
  expect(screen.getByRole("status")).toHaveTextContent(
    "Finish sign-in in your browser",
  );
  const cancel = screen.getByRole("button", { name: "Cancel sign-in" });
  expect(cancel).toBeEnabled();
  await userEvent.setup().click(cancel);
  expect(aborted).toBe(true);
  expect(session.snapshot().status).toBe("signed-out");
  expect(
    screen.queryByRole("button", { name: "Cancel sign-in" }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent(
    "Sign in to choose a model",
  );
  expect(request).not.toHaveBeenCalled();
});
