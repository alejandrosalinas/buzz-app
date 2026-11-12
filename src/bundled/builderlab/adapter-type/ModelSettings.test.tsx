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
import { StrictMode, useLayoutEffect, useRef, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Host } from "../../../features/host/service";
import {
  createAgentClient,
  type RemoteAgent,
  type RemoteAgentModel,
} from "../agents/client";
import { ModelSettings } from "./ModelSettings";
import { deferred, createTestSession } from "../test-helpers";
import { ToastProvider } from "../../../shared/design-system/ui/Toast";

beforeEach(() =>
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example"),
);
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

it.each(["deadline", "cancel"] as const)(
  "waits for broker sign-out before the account-switch spinner and Retry (%s)",
  async (finish) => {
    vi.stubEnv("VITE_BUZZ_LIVE", "1");
    vi.stubEnv("VITE_BUZZ_FEDERATED_IDENTITY", "0");
    let allowed = false;
    const session = createTestSession(
      async () => ({
        revision: crypto.randomUUID(),
        account: {
          subject: "user",
          email: "a@example.com",
          canUseRemoteAgents: allowed,
          canUseBuilderlabDecisions: false,
        },
      }),
      undefined,
      {
        request: vi.fn(async () => ({
          status: 200,
          headers: {},
          body: '{"models":[]}',
        })),
      },
    );
    await session.signIn();
    const signIn = vi.spyOn(session, "signIn");
    const signedOutCommits: { action: string | null; hint: boolean }[] = [];
    function ObserveCommit({ children }: { children: ReactNode }) {
      const control = useRef<HTMLDivElement>(null);
      // Observe the committed DOM before ModelSettings' passive effect runs.
      useLayoutEffect(() => {
        if (session.snapshot().status !== "signed-out") return;
        signedOutCommits.push({
          action:
            control.current
              ?.querySelector("button")
              ?.getAttribute("aria-label") ?? null,
          hint:
            control.current?.parentElement?.textContent?.includes(
              "Sign in to edit settings. You can still message this agent.",
            ) ?? false,
        });
      });
      return <div ref={control}>{children}</div>;
    }
    const signedOut = deferred<void>();
    const signOut = session.signOut;
    const pendingSignOut = vi.fn(async () => {
      await signedOut.promise;
      signOut();
    });
    vi.spyOn(session, "signOut").mockImplementation(() => {
      void pendingSignOut();
    });
    try {
      render(
        <ModelSettings
          client={createAgentClient(session, null)}
          session={session}
          harnessControl={(action) => <ObserveCommit>{action}</ObserveCommit>}
          settings={{
            subject: "user",
            agent: {
              id: "agent",
              name: "Helper",
              pubkey: "ab".repeat(32),
              status: "Active",
              modelSelectionStatus: "valid",
            },
          }}
        />,
      );
      const recovery = await screen.findByRole("button", {
        name: "Use another account",
      });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      fireEvent.click(recovery);
      expect(pendingSignOut).toHaveBeenCalledOnce();
      await act(() => vi.advanceTimersByTimeAsync(5000));
      expect(session.snapshot().status).toBe("signed-in");
      expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
      await act(async () => signedOut.resolve());
      expect(session.snapshot().status).toBe("signed-out");
      expect(signedOutCommits[0]).toEqual({
        action: "Cancel sign-in",
        hint: false,
      });
      const spinner = screen.getByRole("button", { name: "Cancel sign-in" });
      expect(spinner).toHaveAttribute("aria-busy", "true");
      await act(() => vi.advanceTimersByTimeAsync(2999));
      expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
      if (finish === "cancel") fireEvent.click(spinner);
      else await act(() => vi.advanceTimersByTimeAsync(1));
      const retry = screen.getByRole("button", { name: "Retry" });
      expect(retry).toBeEnabled();
      expect(signIn).not.toHaveBeenCalled();
      vi.useRealTimers();
      allowed = true;
      fireEvent.click(retry);
      await waitFor(() => expect(session.snapshot().status).toBe("signed-in"));
      expect(signIn).toHaveBeenCalledOnce();
      expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
      act(() => signOut());
      expect(
        screen.getByRole("button", { name: "Sign in to Builderlab" }),
      ).toBeEnabled();
    } finally {
      await act(async () => signedOut.resolve());
      session.dispose();
      vi.useRealTimers();
    }
  },
);
async function fixture(
  selection: Partial<RemoteAgent> = {},
  catalog?: readonly RemoteAgentModel[],
) {
  let agent: RemoteAgent = {
    id: "agent",
    name: "Helper",
    pubkey: "ab".repeat(32),
    status: "Active",
    modelSelectionStatus: "setup-required",
    ...selection,
  };
  let subject = "account";
  let offline = false;
  const session = createTestSession(
    async () => ({
      revision: "credential",
      account: {
        subject,
        email: "a@example.com",
        canUseRemoteAgents: true,
        canUseBuilderlabDecisions: false,
      },
    }),
    undefined,
    { request: (input) => request(input) },
  );
  await session.signIn();
  const request = vi.fn<Host["request"]>(async ({ url, body }) => {
    if (offline) return { status: 400, headers: {}, body: "{}" };
    let result: unknown;
    if (url.endsWith("/get-model-catalog"))
      result = {
        models: catalog?.map((model) => ({
          id: model.id,
          display_name: model.displayName,
          supported_reasoning_efforts: model.supportedReasoningEfforts,
        })) ?? [
          {
            id: "model-one",
            display_name: "Friendly One",
            supported_reasoning_efforts: ["low", "high"],
          },
          {
            id: "model-two",
            display_name: "Friendly Two",
            supported_reasoning_efforts: ["none"],
          },
        ],
      };
    else if (url.endsWith("/update-agent")) {
      const update = JSON.parse(body ?? "{}");
      agent = {
        ...agent,
        modelId: update.model_id,
        reasoningEffort: update.reasoning_effort,
        modelSelectionStatus: "valid",
      };
      result = {};
    } else
      result = {
        status: 1,
        agents: [
          {
            agent_id: agent.id,
            agent_name: agent.name,
            agent_pubkey: agent.pubkey,
            status: 2,
            model_id: agent.modelId,
            reasoning_effort: agent.reasoningEffort,
            model_selection_status: 1,
          },
        ],
      };
    return { status: 200, headers: {}, body: JSON.stringify(result) };
  });
  const client = createAgentClient(session, null);
  render(
    <ModelSettings
      {...{ client, session }}
      settings={{ agent, subject: "account" }}
    />,
    {
      wrapper: ({ children }) => (
        <StrictMode>
          <ToastProvider>{children}</ToastProvider>
        </StrictMode>
      ),
    },
  );
  await waitFor(() =>
    expect(
      screen
        .getByRole("textbox", { name: "Instructions" })
        .closest("[aria-busy]"),
    ).toHaveAttribute("aria-busy", "false"),
  );
  return {
    request,
    session,
    offline: (value: boolean) => {
      offline = value;
    },
    changeAccount: async (next = "other") => {
      subject = next;
      session.signOut();
      await session.signIn();
    },
  };
}
async function choose(label: string, value: string) {
  const user = userEvent.setup();
  if (label === "Model") {
    const trigger = screen.getByRole("button", { name: /^Model:/ });
    await waitFor(() => expect(trigger).toBeEnabled());
    await user.click(trigger);
    (await screen.findByRole("menuitem", { name: "Other" })).focus();
    await user.keyboard("{ArrowRight}");
    await user.click(await screen.findByRole("menuitemradio", { name: value }));
  } else {
    await user.click(screen.getByRole("combobox", { name: label }));
    await user.click(await screen.findByRole("option", { name: value }));
  }
}
it("keeps the Builderlab mark when no shared Harness control is supplied", async () => {
  await fixture();
  const mark = screen.getByText("Builderlab").querySelector("svg");
  expect(mark).toHaveAttribute("width", "1.25rem");
  expect(mark).toHaveAttribute("aria-hidden", "true");
  expect(mark?.querySelector("mask")).not.toBeNull();
  expect(screen.queryByRole("button", { name: /Change harness/ })).toBeNull();
});

it("shows the instruction limit as accessible field help", async () => {
  await fixture();
  expect(
    screen.getByRole("textbox", { name: "Instructions" }),
  ).toHaveAccessibleDescription("Up to 20,000 characters.");
  expect(screen.getByText("Up to 20,000 characters.")).toBeVisible();
});

it("requires an explicit supported pair, clears effort when the model changes, and reads back server validity", async () => {
  const h = await fixture({ instructions: "Saved instructions." });
  expect(screen.getByRole("button", { name: /^Model:/ })).toHaveTextContent(
    "Choose a model",
  );
  expect(
    screen.queryByRole("button", { name: "Save" }),
  ).not.toBeInTheDocument();
  await choose("Model", "Friendly One");
  expect(
    screen.queryByRole("button", { name: "Save" }),
  ).not.toBeInTheDocument();
  await choose("Thinking", "High");
  await choose("Model", "Friendly Two");
  expect(screen.getByRole("combobox", { name: "Thinking" })).toHaveTextContent(
    "Choose thinking",
  );
  expect(
    screen.queryByRole("button", { name: "Save" }),
  ).not.toBeInTheDocument();
  await choose("Thinking", "None");
  await userEvent.setup().click(screen.getByRole("button", { name: "Save" }));
  expect(
    await screen.findByRole("dialog", { name: "Model preferences saved" }),
  ).toBeVisible();
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  const updates = h.request.mock.calls.filter(([request]) =>
    request.url.endsWith("/update-agent"),
  );
  expect(updates).toHaveLength(1);
  expect(JSON.parse(updates[0]?.[0].body ?? "{}")).toEqual({
    agent_pubkey: "ab".repeat(32),
    model_id: "model-two",
    reasoning_effort: "none",
  });
  expect(screen.getByRole("textbox", { name: "Instructions" })).toHaveValue(
    "Saved instructions.",
  );
  expect(
    screen.queryByRole("button", { name: "Save" }),
  ).not.toBeInTheDocument();
});
it("can clear instructions without changing a model when the catalog is empty", async () => {
  const h = await fixture({ instructions: "Saved instructions." }, []);
  const user = userEvent.setup();
  await user.clear(screen.getByRole("textbox", { name: "Instructions" }));
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull(),
  );
  const updates = h.request.mock.calls.filter(([request]) =>
    request.url.endsWith("/update-agent"),
  );
  expect(updates).toHaveLength(1);
  expect(JSON.parse(updates[0]?.[0].body ?? "{}")).toEqual({
    agent_pubkey: "ab".repeat(32),
    agent_instructions: "",
  });
  expect(screen.getByRole("textbox", { name: "Instructions" })).toHaveValue("");
});

it("preserves the combined draft when model readback fails and retries one combined update", async () => {
  const h = await fixture({ instructions: "Saved instructions." });
  const user = userEvent.setup();
  await choose("Model", "Friendly One");
  await choose("Thinking", "High");
  const field = screen.getByRole("textbox", { name: "Instructions" });
  await user.type(field, " Updated.");
  const implementation = h.request.getMockImplementation();
  if (!implementation) throw new Error("Missing request fixture");
  h.request
    .mockImplementationOnce(implementation)
    .mockResolvedValueOnce({ status: 400, headers: {}, body: "{}" });
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("HTTP 400");
  expect(field).toHaveValue("Saved instructions. Updated.");
  expect(screen.getByRole("button", { name: /^Model:/ })).toHaveTextContent(
    "Friendly One",
  );
  expect(screen.getByRole("combobox", { name: "Thinking" })).toHaveTextContent(
    "High",
  );
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull(),
  );
  expect(screen.queryByRole("alert")).toBeNull();
  const updates = h.request.mock.calls.filter(([request]) =>
    request.url.endsWith("/update-agent"),
  );
  expect(updates).toHaveLength(2);
  for (const [request] of updates)
    expect(JSON.parse(request.body ?? "{}")).toEqual({
      agent_pubkey: "ab".repeat(32),
      agent_instructions: "Saved instructions. Updated.",
      model_id: "model-one",
      reasoning_effort: "high",
    });
});

it("refuses a combined update for an agent that is no longer Active", async () => {
  const h = await fixture({ status: "Revoked" });
  const user = userEvent.setup();
  await choose("Model", "Friendly One");
  await choose("Thinking", "High");
  await user.type(
    screen.getByRole("textbox", { name: "Instructions" }),
    "Changed.",
  );
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Only Active agents",
  );
  expect(
    h.request.mock.calls.filter(([request]) =>
      request.url.endsWith("/update-agent"),
    ),
  ).toHaveLength(0);
});

it("uses Builderlab families in the shared menu and keeps unknown catalog choices selectable", async () => {
  await fixture(
    {
      modelId: "opaque-id",
      reasoningEffort: "high",
      modelSelectionStatus: "valid",
    },
    [
      {
        id: "opaque-id",
        displayName: "Sol 6.1",
        supportedReasoningEfforts: ["high"],
      },
      {
        id: "future-id",
        displayName: "Future Model",
        supportedReasoningEfforts: ["none"],
      },
    ],
  );
  const trigger = screen.getByRole("button", { name: "Model: Sol 6.1" });
  await waitFor(() => expect(trigger).toBeEnabled());
  expect(trigger.querySelector("svg")).toHaveAttribute(
    "viewBox",
    "176 176 364 364",
  );
  const user = userEvent.setup();
  await user.click(trigger);
  expect(await screen.findByRole("menuitem", { name: "OpenAI" })).toBeVisible();
  expect(screen.queryByRole("menuitemradio", { name: /Default/ })).toBeNull();
  const other = screen.getByRole("menuitem", { name: "Other" });
  other.focus();
  await user.keyboard("{ArrowRight}");
  await user.click(
    await screen.findByRole("menuitemradio", { name: "Future Model" }),
  );
  expect(trigger).toHaveTextContent("Future Model");
  expect(screen.getByRole("combobox", { name: "Thinking" })).toHaveTextContent(
    "Choose thinking",
  );
  expect(
    screen.queryByRole("button", { name: "Save" }),
  ).not.toBeInTheDocument();
});

it("shows no warning or success message when opening valid saved preferences", async () => {
  await fixture({
    modelId: "model-one",
    reasoningEffort: "high",
    modelSelectionStatus: "valid",
  });
  expect(screen.getByRole("button", { name: /^Model:/ })).toHaveTextContent(
    "Friendly One",
  );
  expect(screen.getByRole("combobox", { name: "Thinking" })).toHaveTextContent(
    "High",
  );
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("dialog", { name: "Model preferences saved" }),
  ).not.toBeInTheDocument();
});
it.each([
  {
    modelId: "retired",
    reasoningEffort: "high",
    modelSelectionStatus: "model-unavailable" as const,
    status: "no longer available",
  },
  {
    modelId: "model-two",
    reasoningEffort: "high",
    modelSelectionStatus: "effort-unsupported" as const,
    status: "no longer supported",
  },
])(
  "keeps invalid saved selection visible without a fallback: $modelSelectionStatus",
  async ({ status, ...selection }) => {
    await fixture(selection);
    expect(screen.getByRole("status")).toHaveTextContent(status);
    expect(screen.getByRole("status")).toHaveTextContent(
      selection.modelId === "retired" ? "retired" : "Friendly Two",
    );
    expect(
      screen.getByRole("combobox", { name: "Thinking" }),
    ).toHaveTextContent("Choose thinking");
    expect(
      screen.queryByRole("button", { name: "Save" }),
    ).not.toBeInTheDocument();
  },
);
it("preserves a failed draft and refuses to save it through a different account", async () => {
  const h = await fixture();
  await choose("Model", "Friendly One");
  await choose("Thinking", "Low");
  h.offline(true);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("HTTP 400");
  expect(
    screen.queryByRole("dialog", { name: "Model preferences saved" }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "Thinking" })).toHaveTextContent(
    "Low",
  );
  h.offline(false);
  await act(async () => h.changeAccount());
  const before = h.request.mock.calls.length;
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Sign in with another Builderlab account to edit this agent.",
  );
  const field = screen.getByRole("textbox", { name: "Instructions" });
  expect(field).toBeDisabled();
  expect(screen.getByRole("button", { name: /^Model:/ })).toBeDisabled();
  expect(screen.getByRole("combobox", { name: "Thinking" })).toBeDisabled();
  expect(screen.getByRole("combobox", { name: "Thinking" })).toHaveTextContent(
    "Low",
  );
  expect(screen.getByRole("button", { name: /^Model:/ })).toHaveTextContent(
    "Friendly One",
  );
  expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  expect(screen.queryByRole("button", { name: /Retry|Refresh/ })).toBeNull();
  await waitFor(() => expect(screen.queryByText(/HTTP 400/)).toBeNull());
  const form = field.closest("form");
  if (!form) throw new Error("Missing settings form");
  fireEvent.submit(form);
  expect(h.request).toHaveBeenCalledTimes(before);
});

it("checks the live credential before saving even when the displayed session has not changed", async () => {
  const h = await fixture({
    modelId: "model-one",
    reasoningEffort: "high",
    modelSelectionStatus: "valid",
    instructions: "Saved instructions.",
  });
  const user = userEvent.setup();
  const field = screen.getByRole("textbox", { name: "Instructions" });
  await user.type(field, " Draft");
  const before = h.request.mock.calls.length;
  const credential = h.session.credential();
  const read = vi.spyOn(h.session, "credential").mockReturnValue({
    ...credential,
    account: { ...credential.account, subject: "other" },
  });
  try {
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Sign in to the Builderlab account that loaded these settings.",
    );
    expect(h.request).toHaveBeenCalledTimes(before);
    expect(field).toHaveValue("Saved instructions. Draft");
  } finally {
    read.mockRestore();
  }
});

it.each(["save", "catalog"])(
  "recovers from a forbidden %s request through another account without losing the draft",
  async (operation) => {
    vi.stubEnv("VITE_BUZZ_LIVE", "1");
    const h = await fixture({
      modelId: "model-one",
      reasoningEffort: "high",
      modelSelectionStatus: "valid",
      instructions: "Saved instructions.",
    });
    const user = userEvent.setup();
    await user.type(
      screen.getByRole("textbox", { name: "Instructions" }),
      " Draft",
    );
    h.request.mockResolvedValueOnce({ status: 403, headers: {}, body: "{}" });
    if (operation === "save")
      await user.click(screen.getByRole("button", { name: "Save" }));
    else {
      act(() => h.session.signOut());
      await act(() => h.session.signIn());
    }
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This Builderlab account cannot manage remote agents.",
    );
    expect(
      screen.getByRole("button", { name: "Use another account" }),
    ).toBeEnabled();
    expect(
      screen.queryByRole("button", { name: /Retry|Try again|Save/ }),
    ).toBeNull();
    act(() => h.session.signOut());
    await act(() => h.session.signIn());
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^Model:/ })).toBeEnabled(),
    );
    expect(screen.getByRole("textbox", { name: "Instructions" })).toHaveValue(
      "Saved instructions. Draft",
    );
    expect(screen.queryByRole("alert")).toBeNull();
  },
);

it("replaces a previous account's catalog error with mismatch guidance and recovers on the original account", async () => {
  const h = await fixture({
    modelId: "model-one",
    reasoningEffort: "high",
    modelSelectionStatus: "valid",
    instructions: "Saved instructions.",
  });
  const user = userEvent.setup();
  let field = screen.getByRole("textbox", { name: "Instructions" });
  await user.type(field, " Draft");
  h.offline(true);
  act(() => h.session.signOut());
  await act(() => h.session.signIn());
  expect(await screen.findByRole("alert")).toHaveTextContent("HTTP 400");
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Retry models" })).toBeVisible(),
  );
  await act(() => h.changeAccount());
  const before = h.request.mock.calls.length;
  expect(screen.getAllByRole("alert")).toHaveLength(1);
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Sign in with another Builderlab account to edit this agent.",
  );
  await waitFor(() => expect(screen.queryByText(/HTTP 400/)).toBeNull());
  expect(
    screen.queryByRole("button", { name: /Retry|Refresh|Save/ }),
  ).toBeNull();
  field = screen.getByRole("textbox", { name: "Instructions" });
  expect(field).toBeDisabled();
  expect(field).toHaveValue("Saved instructions. Draft");
  await user.type(field, " Ignored");
  const form = field.closest("form");
  if (!form) throw new Error("Missing settings form");
  fireEvent.submit(form);
  expect(h.request).toHaveBeenCalledTimes(before);
  h.offline(false);
  await act(() => h.changeAccount("account"));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /^Model:/ })).toBeEnabled(),
  );
  field = screen.getByRole("textbox", { name: "Instructions" });
  expect(field).toBeEnabled();
  expect(field).toHaveValue("Saved instructions. Draft");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
});

it.each(["save", "catalog"])(
  "hides an earlier %s error and retry after signing out",
  async (kind) => {
    const h = await fixture({
      modelId: "model-one",
      reasoningEffort: "high",
      modelSelectionStatus: "valid",
      instructions: "Saved instructions.",
    });
    const user = userEvent.setup();
    const field = screen.getByRole("textbox", { name: "Instructions" });
    await user.type(field, " Draft");
    h.offline(true);
    if (kind === "save")
      await user.click(screen.getByRole("button", { name: "Save" }));
    else {
      act(() => h.session.signOut());
      await act(() => h.session.signIn());
    }
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("HTTP 400");
    expect(
      screen.getByRole("region", {
        name:
          kind === "save" ? "Couldn’t save changes" : "Couldn’t load models",
      }),
    ).toContainElement(alert);
    await waitFor(() =>
      expect(
        screen.getByRole("button", {
          name: kind === "save" ? "Try again" : "Retry models",
        }),
      ).toBeVisible(),
    );
    const before = h.request.mock.calls.length;
    const signIn = vi.spyOn(h.session, "signIn");
    act(() => h.session.signOut());
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: /Retry|Refresh/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Instructions" })).toBeNull();
    expect(h.request).toHaveBeenCalledTimes(before);
    expect(signIn).not.toHaveBeenCalled();
    h.offline(false);
    await act(() => h.session.signIn());
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^Model:/ })).toBeEnabled(),
    );
    expect(screen.getByRole("textbox", { name: "Instructions" })).toHaveValue(
      "Saved instructions. Draft",
    );
  },
);

it("keeps the session and the draft when Builderlab refuses a save, and saves on retry", async () => {
  const h = await fixture({
    modelId: "model-one",
    reasoningEffort: "high",
    modelSelectionStatus: "valid",
    instructions: "Saved instructions.",
  });
  const user = userEvent.setup();
  const field = screen.getByRole("textbox", { name: "Instructions" });
  await user.type(field, " Draft");
  h.request.mockResolvedValueOnce({ status: 401, headers: {}, body: "{}" });
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Builderlab didn’t accept this request. Try again.",
  );
  // A 401 refuses only this call: the native session decides when it ends.
  expect(h.session.snapshot().status).toBe("signed-in");
  expect(field).toHaveValue("Saved instructions. Draft");
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(
    h.request.mock.calls.filter(([request]) =>
      request.url.endsWith("/update-agent"),
    ),
  ).toHaveLength(2);
});

it("retries a failed catalog request without saving the draft", async () => {
  const h = await fixture({
    modelId: "model-one",
    reasoningEffort: "high",
    modelSelectionStatus: "valid",
    instructions: "Saved instructions.",
  });
  const user = userEvent.setup();
  const field = screen.getByRole("textbox", { name: "Instructions" });
  await user.type(field, " Draft");
  h.offline(true);
  act(() => h.session.signOut());
  await act(() => h.session.signIn());
  const retry = await screen.findByRole("button", { name: "Retry models" });
  expect(screen.getByRole("alert")).toHaveTextContent("HTTP 400");
  h.offline(false);
  await user.click(retry);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /^Model:/ })).toBeEnabled(),
  );
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("textbox", { name: "Instructions" })).toHaveValue(
    "Saved instructions. Draft",
  );
  expect(
    h.request.mock.calls.filter(([request]) =>
      request.url.endsWith("/update-agent"),
    ),
  ).toHaveLength(0);
});

it("retries a failed save with the current draft and blocks duplicate writes while pending", async () => {
  const h = await fixture();
  await choose("Model", "Friendly One");
  await choose("Thinking", "Low");
  const user = userEvent.setup();
  h.offline(true);
  await user.click(screen.getByRole("button", { name: "Save" }));
  await user.click(await screen.findByRole("button", { name: "Try again" }));
  expect(screen.getByRole("alert")).toHaveTextContent("HTTP 400");
  expect(
    h.request.mock.calls.filter(([request]) =>
      request.url.endsWith("/update-agent"),
    ),
  ).toHaveLength(2);
  const instructions = screen.getByRole("textbox", { name: "Instructions" });
  await user.type(instructions, "Latest draft");
  const gate = deferred<void>();
  const request = h.request.getMockImplementation();
  if (!request) throw new Error("Missing request implementation");
  h.request.mockImplementationOnce(async (...args) => {
    await gate.promise;
    return request(...args);
  });
  h.offline(false);
  try {
    await user.click(await screen.findByRole("button", { name: "Try again" }));
    const save = screen.getByRole("button", { name: "Saving…" });
    expect(save).toHaveAttribute("aria-disabled", "true");
    await user.click(save);
    const form = instructions.closest("form");
    if (!form) throw new Error("Missing settings form");
    fireEvent.submit(form);
    const writes = h.request.mock.calls.filter(([row]) =>
      row.url.endsWith("/update-agent"),
    );
    expect(writes).toHaveLength(3);
    const body = writes[2]?.[0].body;
    if (!body) throw new Error("Missing retried settings write");
    expect(JSON.parse(body)).toMatchObject({
      agent_instructions: "Latest draft",
      model_id: "model-one",
      reasoning_effort: "low",
    });
  } finally {
    await act(async () => gate.resolve());
  }
  expect(
    await screen.findByRole("dialog", { name: "Model preferences saved" }),
  ).toBeVisible();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
