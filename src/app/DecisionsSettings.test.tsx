// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { Context } from "@deepseek-ai/cordis";
import type { ReactNode } from "react";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import {
  DEFAULT_DECISION_PROVIDER,
  DecisionsService,
  type DecisionProviderStatus,
  type RegisteredProvider,
} from "../features/decisions/service";
import { DecisionsSettings } from "./DecisionsSettings";

afterEach(cleanup);

const TYPESAFE = DEFAULT_DECISION_PROVIDER;

/** The decisions service as Settings uses it, choosing as the service does:
 * the saved choice, else TypeSafe. A choice that is not registered answers
 * nothing. Labels name TypeSafe's key as "typesafe". */
function fake(
  entries: ({
    key: string;
    status: DecisionProviderStatus;
    /** Replaces the status read, for a provider whose status throws. */
    readStatus?: RegisteredProvider["status"];
  } & Partial<Pick<RegisteredProvider, "Settings" | "showSettingsHeading">>)[],
  chosen?: string,
) {
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  const statuses = new Map(entries.map((entry) => [entry.key, entry.status]));
  const providers: RegisteredProvider[] = entries.map(({ key, ...entry }) => {
    const name = key === TYPESAFE ? "typesafe" : key;
    return {
      key,
      id: key,
      pluginId: key,
      revision: "one",
      label: `Provider ${name}`,
      description: `About ${name}.`,
      status: () => statuses.get(key) ?? "needs-setup",
      subscribe: () => () => {},
      decide: async () => ({ outcome: "failed", reason: "unavailable" }),
      Settings: () => <p>Settings for {name}</p>,
      ...(entry.Settings ? { Settings: entry.Settings } : {}),
      ...(entry.showSettingsHeading !== undefined
        ? { showSettingsHeading: entry.showSettingsHeading }
        : {}),
      ...(entry.readStatus ? { status: entry.readStatus } : {}),
    };
  });
  const backend = () =>
    providers.find((provider) => provider.key === (chosen ?? TYPESAFE))?.key;
  return {
    providers: () => providers,
    backend,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    setBackend(key: string) {
      chosen = key;
      notify();
    },
    chosen: () => chosen,
    setStatus(key: string, status: DecisionProviderStatus) {
      statuses.set(key, status);
      notify();
    },
  };
}

it("says to turn a provider on when none is, linking to Manage plugins", async () => {
  const user = userEvent.setup();
  const onSection = vi.fn();
  render(
    <DecisionsSettings
      decisions={fake([])}
      active={() => true}
      onSection={onSection}
    />,
  );
  expect(screen.getByRole("heading", { name: "Decisions API" })).toBeVisible();
  const status = screen.getByRole("status");
  expect(status).toHaveTextContent(
    "No decision provider is turned on. Turn one on in Manage plugins.",
  );
  await user.click(
    within(status).getByRole("button", { name: "Manage plugins" }),
  );
  expect(onSection).toHaveBeenCalledExactlyOnceWith("plugins");
});

it("shows a lone provider's settings and honors its heading preference", () => {
  const view = (showSettingsHeading?: boolean) => (
    <DecisionsSettings
      decisions={fake([
        {
          key: TYPESAFE,
          status: "needs-setup",
          ...(showSettingsHeading === false ? { showSettingsHeading } : {}),
        },
      ])}
      active={() => true}
    />
  );
  const { rerender } = render(view());
  expect(screen.queryByRole("radio")).toBeNull();
  expect(
    screen.getByRole("heading", { name: "Provider typesafe" }),
  ).toBeVisible();
  rerender(view(false));
  expect(
    screen.queryByRole("heading", { name: "Provider typesafe" }),
  ).toBeNull();
  expect(screen.getByText("Settings for typesafe")).toBeVisible();
});

it("says once, above every provider's settings, that the provider receives message text", () => {
  render(
    <DecisionsSettings
      decisions={fake([
        { key: TYPESAFE, status: "ready" },
        { key: "b", status: "needs-setup" },
      ])}
      active={() => true}
    />,
  );
  expect(
    screen.getAllByText(
      /provider handles these questions and receives the message text/,
    ),
  ).toHaveLength(1);
  const disclosure = screen.getByText(
    /provider handles these questions and receives the message text/,
  );
  expect(disclosure).toHaveTextContent("private channels");
  expect(
    disclosure.compareDocumentPosition(
      screen.getByText("Settings for typesafe"),
    ) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});

it("chooses a ready provider at once", async () => {
  const user = userEvent.setup();
  const decisions = fake([
    { key: TYPESAFE, status: "ready" },
    { key: "b", status: "ready" },
  ]);
  render(<DecisionsSettings decisions={decisions} active={() => true} />);
  expect(
    screen.getByRole("radio", { name: /Provider typesafe/ }),
  ).toBeChecked();
  await user.click(screen.getByRole("radio", { name: /Provider b/ }));
  expect(decisions.chosen()).toBe("b");
  expect(screen.getByRole("radio", { name: /Provider b/ })).toBeChecked();
  expect(screen.getByText("Settings for b")).toBeVisible();
});

it("shows the settings of one picked before it is ready, and saves the choice once it is", async () => {
  const user = userEvent.setup();
  const decisions = fake([
    { key: TYPESAFE, status: "ready" },
    { key: "b", status: "needs-setup" },
  ]);
  render(<DecisionsSettings decisions={decisions} active={() => true} />);
  await user.click(screen.getByRole("radio", { name: /Provider b/ }));
  // The working provider keeps answering until b is set up.
  expect(decisions.chosen()).toBeUndefined();
  expect(decisions.backend()).toBe(TYPESAFE);
  expect(screen.getByRole("radio", { name: /Provider b/ })).toBeChecked();
  expect(screen.getByText("Settings for b")).toBeVisible();
  act(() => decisions.setStatus("b", "ready"));
  expect(decisions.chosen()).toBe("b");
  expect(screen.getByRole("radio", { name: /Provider b/ })).toBeChecked();
});

it("changes nothing while hidden", async () => {
  const user = userEvent.setup();
  const decisions = fake([
    { key: TYPESAFE, status: "ready" },
    { key: "b", status: "ready" },
  ]);
  render(<DecisionsSettings decisions={decisions} active={() => false} />);
  await user.click(screen.getByRole("radio", { name: /Provider b/ }));
  expect(decisions.chosen()).toBeUndefined();
});

it("keeps a provider's failing settings inside its own part, even while hidden", async () => {
  const user = userEvent.setup();
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  const decisions = fake([
    {
      key: TYPESAFE,
      status: "ready",
      Settings: () => {
        throw new Error("broken plugin");
      },
    },
    { key: "b", status: "ready" },
  ]);
  let selected = "plugins";
  const onSection = vi.fn();
  // Settings mounts the Decisions section while another one is shown.
  const page = () => (
    <>
      <button type="button">Turn plugin off</button>
      <div hidden={selected !== "decisions"}>
        <DecisionsSettings
          decisions={decisions}
          active={() => selected === "decisions"}
          onSection={onSection}
        />
      </div>
    </>
  );
  const { rerender } = render(page());
  expect(screen.getByRole("button", { name: "Turn plugin off" })).toBeVisible();
  selected = "decisions";
  rerender(page());
  const alert = screen.getByRole("alert");
  expect(alert).toHaveTextContent(
    "Provider typesafe settings are unavailable. You can turn its plugin off in Manage plugins.",
  );
  await user.click(
    within(alert).getByRole("button", { name: "Manage plugins" }),
  );
  expect(onSection).toHaveBeenCalledExactlyOnceWith("plugins");
  // The rest of the section still works.
  await user.click(screen.getByRole("radio", { name: /Provider b/ }));
  expect(decisions.chosen()).toBe("b");
  expect(screen.getByText("Settings for b")).toBeInTheDocument();
  consoleError.mockRestore();
});

it("treats a provider whose status throws as not ready", async () => {
  const user = userEvent.setup();
  const decisions = fake([
    { key: TYPESAFE, status: "ready" },
    {
      key: "b",
      status: "ready",
      readStatus: () => {
        throw new Error("broken status");
      },
    },
  ]);
  render(<DecisionsSettings decisions={decisions} active={() => true} />);
  await user.click(screen.getByRole("radio", { name: /Provider b/ }));
  // Shown, as one picked before it is ready, but not chosen.
  expect(screen.getByText("Settings for b")).toBeVisible();
  expect(decisions.chosen()).toBeUndefined();
  expect(decisions.backend()).toBe(TYPESAFE);
});

it("offers a lone provider when the chosen one is gone, and answers only once it is chosen", async () => {
  const user = userEvent.setup();
  // The user chose b, then turned b's plugin off.
  const decisions = fake([{ key: TYPESAFE, status: "ready" }], "b");
  render(<DecisionsSettings decisions={decisions} active={() => true} />);
  expect(decisions.backend()).toBeUndefined();
  const radio = screen.getByRole("radio", { name: /Provider typesafe/ });
  expect(radio).not.toBeChecked();
  expect(screen.queryByText("Settings for typesafe")).toBeNull();
  await user.click(radio);
  expect(decisions.chosen()).toBe(TYPESAFE);
  expect(decisions.backend()).toBe(TYPESAFE);
  expect(screen.getByText("Settings for typesafe")).toBeVisible();
  // The choice stays for this visit, so focus stays on it.
  expect(radio).toBeChecked();
  expect(radio).toHaveFocus();
});

it("offers a lone other provider when TypeSafe is off, and sets it up before choosing it", async () => {
  const user = userEvent.setup();
  const decisions = fake([{ key: "b", status: "needs-setup" }]);
  render(<DecisionsSettings decisions={decisions} active={() => true} />);
  expect(decisions.backend()).toBeUndefined();
  await user.click(screen.getByRole("radio", { name: /Provider b/ }));
  // Its setup is reachable, but nothing answers until it is ready.
  expect(screen.getByText("Settings for b")).toBeVisible();
  expect(decisions.chosen()).toBeUndefined();
  act(() => decisions.setStatus("b", "ready"));
  expect(decisions.chosen()).toBe("b");
  expect(decisions.backend()).toBe("b");
  const radio = screen.getByRole("radio", { name: /Provider b/ });
  expect(radio).toBeChecked();
  expect(radio).toHaveFocus();
});

/** The real service with TypeSafe and a provider the test can remove, as a
 * Builderlab sign-out does. Its settings have a Sign out button that does. */
async function withdrawable(typesafe = true) {
  const root = new Context();
  root.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const decisions = new DecisionsService(root, undefined);
  const provider = (id: string, Settings?: () => ReactNode) => ({
    id,
    label: id,
    description: `About ${id}.`,
    status: () => "ready" as const,
    subscribe: () => () => {},
    decide: async () => ({
      outcome: "failed" as const,
      reason: "unavailable" as const,
    }),
    ...(Settings ? { Settings } : {}),
  });
  let remove = () => {};
  const register = (plugin: string, entry: ReturnType<typeof provider>) =>
    root
      .extend({ pluginOwner: { id: plugin, revision: "one" } })
      .plugin((ctx) => {
        const stop = ctx.decisions.registerProvider(entry);
        if (plugin === "block.builderlab") remove = stop;
      })
      .await();
  if (typesafe) await register("buzz.typesafe", provider("typesafe"));
  await register(
    "block.builderlab",
    provider("builderlab", () => (
      <button type="button" onClick={() => remove()}>
        Sign out
      </button>
    )),
  );
  return { decisions, withdraw: () => act(() => remove()) };
}

it("hands focus to the selected radio when the focused provider's own radio goes", async () => {
  const { decisions, withdraw } = await withdrawable();
  render(<DecisionsSettings decisions={decisions} active={() => true} />);
  expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
  screen.getByRole("combobox", { name: "Decision provider" }).focus();
  await withdraw();
  expect(screen.queryByRole("radio", { name: /builderlab/ })).toBeNull();
  expect(screen.getByRole("radio", { name: /typesafe/ })).toHaveFocus();
});

it("leaves focus elsewhere alone when a provider is removed, as by a 401", async () => {
  const { decisions, withdraw } = await withdrawable();
  render(
    <>
      <button type="button">Elsewhere</button>
      <DecisionsSettings decisions={decisions} active={() => true} />
    </>,
  );
  const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
  elsewhere.focus();
  await withdraw();
  expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
  expect(elsewhere).toHaveFocus();
});

it("hands focus to the section when the removed provider was the only one", async () => {
  const user = userEvent.setup();
  const { decisions } = await withdrawable(false);
  render(<DecisionsSettings decisions={decisions} active={() => true} />);
  screen.getByRole("button", { name: "Sign out" }).focus();
  await user.keyboard("{Enter}");
  expect(screen.getByRole("status")).toHaveTextContent("Manage plugins");
  expect(screen.getByRole("region", { name: "Decisions API" })).toHaveFocus();
});

it("offers Builderlab first and reveals key setup without switching until ready", async () => {
  const user = userEvent.setup();
  const builderlab = "block.builderlab/builderlab";
  const decisions = fake(
    [
      { key: builderlab, status: "ready" },
      { key: TYPESAFE, status: "needs-setup" },
    ],
    builderlab,
  );
  render(<DecisionsSettings decisions={decisions} active={() => true} />);
  const toggle = screen.getByRole("combobox", { name: "Decision provider" });
  expect(toggle).toHaveTextContent("Builderlab");
  expect(screen.queryByText("Settings for typesafe")).toBeNull();
  await user.click(toggle);
  // The Select opens on an animation frame after the pointer press.
  await user.click(await screen.findByRole("option", { name: "TypeSafe" }));
  expect(toggle).toHaveTextContent("Builderlab");
  expect(
    screen.getByRole("dialog", { name: "Connect TypeSafe" }),
  ).toBeVisible();
  expect(screen.getByText("Settings for typesafe")).toBeVisible();
  expect(decisions.chosen()).toBe(builderlab);
  await user.click(screen.getByRole("button", { name: "Close" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(decisions.chosen()).toBe(builderlab);
  await user.click(toggle);
  await user.click(await screen.findByRole("option", { name: "TypeSafe" }));
  act(() => decisions.setStatus(TYPESAFE, "ready"));
  expect(decisions.chosen()).toBe(TYPESAFE);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(toggle).toHaveTextContent("TypeSafe");
  await user.click(toggle);
  await user.click(await screen.findByRole("option", { name: "Builderlab" }));
  expect(decisions.chosen()).toBe(builderlab);
  expect(screen.queryByText("Settings for typesafe")).toBeNull();
});

it("explains lost Builderlab access only while it is selected and confirmed unavailable", async () => {
  const user = userEvent.setup();
  const builderlab = "block.builderlab/builderlab";
  const decisions = fake(
    [
      { key: builderlab, status: "ready" },
      { key: TYPESAFE, status: "ready" },
    ],
    builderlab,
  );
  render(<DecisionsSettings decisions={decisions} active={() => true} />);
  const unavailable = () => screen.queryByRole("status");
  expect(unavailable()).toBeNull();
  act(() => decisions.setStatus(builderlab, "needs-setup"));
  expect(screen.getByLabelText("Unavailable for this account")).toBeVisible();
  expect(unavailable()).toHaveTextContent(
    "Decisions API isn’t available for this Builderlab account. Use your own TypeSafe key or contact your account administrator.",
  );
  expect(screen.queryByText(`Settings for ${builderlab}`)).toBeNull();
  expect(decisions.chosen()).toBe(builderlab);
  act(() => decisions.setStatus(builderlab, "checking"));
  expect(screen.queryByLabelText("Unavailable for this account")).toBeNull();
  expect(unavailable()).toBeNull();
  act(() => decisions.setStatus(builderlab, "ready"));
  expect(unavailable()).toBeNull();
  act(() => decisions.setStatus(builderlab, "needs-setup"));
  await user.click(screen.getByRole("combobox", { name: "Decision provider" }));
  expect(
    await screen.findByRole("option", { name: "Builderlab" }),
  ).toHaveAccessibleDescription("Unavailable for this account");
  act(() => decisions.setStatus(builderlab, "ready"));
  expect(
    screen.getByRole("option", { name: "Builderlab" }),
  ).not.toHaveAccessibleDescription();
  act(() => decisions.setStatus(builderlab, "needs-setup"));
  await user.click(await screen.findByRole("option", { name: "TypeSafe" }));
  expect(unavailable()).toBeNull();
  expect(decisions.chosen()).toBe(TYPESAFE);
});
