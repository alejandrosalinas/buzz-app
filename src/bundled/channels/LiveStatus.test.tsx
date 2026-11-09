// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render as mount, screen } from "@testing-library/react";
afterEach(() => {
  cleanup();
});
import { renderToStaticMarkup } from "react-dom/server";
import type { RelaySession } from "../../features/relay/session";
import { LiveStatus } from "./LiveStatus";

type Snapshot = ReturnType<RelaySession["live"]["snapshot"]>;
const channel = {
  id: "channel:a",
  channelId: "a",
  status: "live",
  replay: "unknown",
} as const;
const base: Snapshot = {
  status: "connected",
  routes: [channel],
  roster: { state: "verified" },
  heads: [],
};
/** A session recovery owner fixed in one state. Production derives it from
 * the same live snapshot; "shown" is any failure past its first retry. */
function recoveryIn(state: "idle" | "shown") {
  const snapshot = Object.freeze(
    state === "shown"
      ? { recovering: true, attempt: 1, shown: true, reauthorized: 0 }
      : { recovering: false, attempt: 0, shown: false, reauthorized: 0 },
  );
  return {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    retryNow: vi.fn(),
    retryAll: vi.fn(),
    dispose() {},
  };
}
function render(
  patch: Partial<Snapshot> = {},
  partialRoster = false,
  diagnostics = false,
  recovery: "idle" | "shown" = "idle",
) {
  const snapshot: Snapshot = { ...base, ...patch };
  const live = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    retry() {},
  };
  const component = (
    <LiveStatus
      live={live}
      channelId="a"
      partialRoster={partialRoster}
      diagnostics={diagnostics}
      recovery={recoveryIn(recovery)}
    />
  );
  if (diagnostics) return renderToStaticMarkup(component);
  cleanup();
  mount(component);
  return screen.queryByRole("status")?.textContent ?? "";
}
it.each<Partial<Snapshot>>([
  {},
  { status: "connecting", routes: [] },
  { routes: [] },
  { routes: [{ ...channel, status: "pending" }] },
  {
    routes: [channel, { id: "profiles", status: "pending", replay: "unknown" }],
  },
  { heads: [{ channelId: "a", state: "deferred" }] },
])(
  "does not turn ordinary setup into a yellow recovery warning: %j",
  async (patch) => {
    expect(await render(patch)).toBe("");
  },
);
it("reports clean connection progress in diagnostics without a retry action", async () => {
  expect(
    await render({ routes: [{ ...channel, status: "pending" }] }, false, true),
  ).toContain("connecting");
  expect(await render({}, false, true)).toContain("stream established");
  expect(await render({ status: "connecting" }, false, true)).not.toContain(
    "button",
  );
});
it.each<Partial<Snapshot>>([
  { status: "error" },
  { status: "retrying" },
  { status: "unavailable" },
  { error: "Socket refused" },
  { routes: [{ ...channel, status: "limited" }] },
  { routes: [{ ...channel, status: "error" }] },
  { heads: [{ channelId: "a", state: "error", error: "Head read failed" }] },
  { roster: { state: "error", error: "Roster refused" } },
  { roster: { state: "deferred" } },
])(
  "leaves degraded coverage or failures to the shown recovery notice: %j",
  async (patch) => {
    // The floating notice is the one report; nothing repeats it above the composer.
    expect(await render(patch, false, false, "shown")).toBe("");
  },
);
it.each(["channel", "global"])(
  "keeps bounded pending %s quota recovery in Diagnostics only",
  async (owner) => {
    const error = "rate-limited: quota exceeded; retry in 2s";
    const routes: Snapshot["routes"] =
      owner === "channel"
        ? [{ ...channel, status: "pending", error }]
        : [
            channel,
            { id: "profiles", status: "pending", replay: "unknown", error },
          ];
    expect(await render({ routes })).toBe("");
    const diagnostics = await render({ routes }, false, true);
    expect(diagnostics).toContain("recovering automatically");
    expect(diagnostics).toContain(`Last rejection: ${error}`);
    expect(diagnostics).not.toContain("stream established");
  },
);
const quota = "rate-limited: quota exceeded; retry in 4s";
const recovering = { ...channel, status: "pending", error: quota } as const;
it.each<Partial<Snapshot>>([
  { error: "Socket control failed" },
  { status: "retrying" },
  { roster: { state: "error", error: quota } },
  { heads: [{ channelId: "a", state: "error", error: `ReadError: ${quota}` }] },
  {
    routes: [
      recovering,
      {
        id: "profiles",
        status: "error",
        replay: "unknown",
        error: "Profile stream stopped",
      },
    ],
  },
  { routes: [{ ...channel, status: "error", error: quota }] },
  {
    routes: [
      {
        ...channel,
        status: "pending",
        error: "rate-limited: shared admission unavailable",
      },
    ],
  },
  {
    routes: [
      {
        ...channel,
        status: "pending",
        error: "rate-limited: quota exceeded; retry in 61s",
      },
    ],
  },
  {
    routes: [
      { ...channel, status: "pending", error: "rate-limited: quota exceeded" },
    ],
  },
])(
  "does not hide actionable or unsupported failures behind automatic recovery: %j",
  async (patch) => {
    expect(await render({ routes: [recovering], ...patch })).toContain(
      "Live updates limited",
    );
    // Once the recovery notice shows, it is the one report.
    expect(
      await render({ routes: [recovering], ...patch }, false, false, "shown"),
    ).toBe("");
  },
);
it("a recovering global cannot hide a selected channel failure", async () => {
  expect(
    await render(
      {
        routes: [
          { ...channel, status: "error", error: "Selected stream stopped" },
          {
            id: "profiles",
            status: "pending",
            replay: "unknown",
            error: quota,
          },
        ],
      },
      false,
      false,
      "shown",
    ),
  ).toBe("");
  // The recovery notice gives no reason; Diagnostics keeps it.
  expect(
    await render(
      {
        routes: [
          { ...channel, status: "error", error: "Selected stream stopped" },
          {
            id: "profiles",
            status: "pending",
            replay: "unknown",
            error: quota,
          },
        ],
      },
      false,
      true,
    ),
  ).toContain("Selected stream stopped");
});
it("keeps partial roster coverage visible even with healthy established routes", async () => {
  expect(await render({}, true)).toContain("Some channels are missing");
  // Automatic recovery cannot add missing channels: say so without promising it.
  expect(await render({}, true)).toContain(
    "Only currently accessible messages remain readable.",
  );
  expect(await render({}, true)).not.toContain("retrying");
  expect(await render({ routes: [recovering] }, true)).toContain(
    "Some channels are missing",
  );
});

it.each(["pending"] as const)(
  "keeps partial roster coverage quiet while discovery is %s",
  async (state) => {
    expect(await render({ roster: { state } }, true)).toBe("");
    expect(await render({ roster: { state } }, true, true)).not.toContain(
      "Some channels are missing",
    );
  },
);
it.each(["error", "deferred"] as const)(
  "offers roster recovery when partial discovery is %s",
  async (state) => {
    expect(await render({ roster: { state } }, true, false, "shown")).toBe("");
  },
);
it.each<Partial<Snapshot>>([{ error: "Socket refused" }])(
  "pending partial discovery does not hide another failure: %j",
  async (patch) => {
    const notice = await render(
      { ...patch, roster: { state: "pending" } },
      true,
      false,
      "shown",
    );
    expect(notice).toBe("");
  },
);

it("diagnostics does not duplicate notices; changing the selected channel/session replaces the notice", async () => {
  const oldRetry = vi.fn();
  const retry = vi.fn();
  const live = (channelId: string, action: () => void) => {
    const snapshot: Snapshot = {
      ...base,
      routes: [{ ...channel, channelId, status: "error" }],
    };
    return {
      snapshot: () => snapshot,
      subscribe: () => () => {},
      retry: action,
    };
  };
  const oldSession = live("a", oldRetry);
  const newSession = live("b", retry);
  const content = (
    session: typeof oldSession,
    channelId: string,
    visible = true,
  ) => (
    <>
      {visible && (
        <>
          <LiveStatus
            live={session}
            channelId={channelId}
            partialRoster={false}
            diagnostics
          />
          <LiveStatus
            live={session}
            channelId={channelId}
            partialRoster={false}
          />
        </>
      )}
    </>
  );
  const view = mount(content(oldSession, "a"));
  expect(screen.getAllByRole("status")).toHaveLength(1);
  view.rerender(content(newSession, "b"));
  expect(screen.getAllByRole("status")).toHaveLength(1);
  // Recovery is automatic and owned by the session; the notice has no
  // per-panel Retry and never retries on render.
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
  expect(retry).not.toHaveBeenCalled();
  expect(oldRetry).not.toHaveBeenCalled();
  view.rerender(content(newSession, "b", false));
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});

it("stays empty while recovery runs, before and after its notice shows", async () => {
  const failed: Snapshot = { ...base, status: "retrying" };
  const quietState = Object.freeze({
    recovering: true,
    attempt: 0,
    shown: false,
    reauthorized: 0,
  });
  const live = {
    snapshot: () => failed,
    subscribe: () => () => {},
    retry: vi.fn(),
  };
  const quiet = {
    ...recoveryIn("idle"),
    snapshot: () => quietState,
  };
  const view = mount(
    <LiveStatus
      live={live}
      channelId="a"
      partialRoster={false}
      recovery={quiet}
    />,
  );
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  view.rerender(
    <LiveStatus
      live={live}
      channelId="a"
      partialRoster={false}
      recovery={recoveryIn("shown")}
    />,
  );
  // The floating notice reports it; no strip or button above the composer.
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
});

it("hands focus on when the recovery notice replaces a focused Retry live updates", () => {
  const denied: Snapshot = {
    ...base,
    status: "error",
    error: "Relay rejected live authentication",
  };
  const onRecovered = vi.fn();
  const content = (state: "idle" | "shown") => (
    <LiveStatus
      live={{ snapshot: () => denied, subscribe: () => () => {}, retry() {} }}
      channelId="a"
      partialRoster={false}
      recovery={recoveryIn(state)}
      onRecovered={onRecovered}
    />
  );
  const view = mount(content("idle"));
  screen.getByRole("button", { name: "Retry live updates" }).focus();
  view.rerender(content("shown"));
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
  expect(onRecovered).toHaveBeenCalledTimes(1);
});

it("shows a permanent live failure even while other reads recover", () => {
  const denied: Snapshot = {
    ...base,
    status: "error",
    error: "Relay rejected live authentication",
  };
  const live = {
    snapshot: () => denied,
    subscribe: () => () => {},
    retry: vi.fn(),
  };
  const quietState = Object.freeze({
    recovering: true,
    attempt: 0,
    shown: false,
    reauthorized: 0,
  });
  const quiet = { ...recoveryIn("idle"), snapshot: () => quietState };
  const onRecovered = vi.fn();
  mount(
    <LiveStatus
      live={live}
      channelId="a"
      partialRoster={false}
      recovery={quiet}
      onRecovered={onRecovered}
    />,
  );
  expect(
    screen.getByRole("status", { name: "Live updates limited" }),
  ).toHaveTextContent("Relay rejected live authentication");
  // Recovery skips a terminal failure, so the user keeps an explicit retry
  // for after they fix the signer or access problem.
  const retry = screen.getByRole("button", { name: "Retry live updates" });
  retry.focus();
  retry.click();
  expect(live.retry).toHaveBeenCalledTimes(1);
  // Nothing changed yet, so the notice and its focused Retry stay.
  expect(retry).toHaveFocus();
  expect(onRecovered).not.toHaveBeenCalled();
});

it.each([
  [
    "a connection",
    {
      ...base,
      status: "error",
      error: "Relay rejected live authentication",
    } as Snapshot,
    { ...base, status: "connecting" } as Snapshot,
  ],
  [
    "a channel route",
    {
      ...base,
      routes: [
        { ...channel, status: "error", error: "blocked: channel archived" },
      ],
    } as Snapshot,
    // The live layer keeps the refusal on the route while it tries again.
    {
      ...base,
      routes: [
        { ...channel, status: "pending", error: "blocked: channel archived" },
      ],
    } as Snapshot,
  ],
])(
  "keeps the notice and Retry through a slow retry of %s, and hands focus on once it succeeds",
  (_, failed, retrying) => {
    const onRecovered = vi.fn();
    const content = (view: Snapshot) => (
      <LiveStatus
        live={{
          snapshot: () => view,
          subscribe: () => () => {},
          retry: vi.fn(),
        }}
        channelId="a"
        partialRoster={false}
        recovery={recoveryIn("idle")}
        onRecovered={onRecovered}
      />
    );
    const notice = () =>
      screen.queryByRole("status", { name: "Live updates limited" });
    const view = mount(content(failed));
    const reason = notice()?.textContent;
    screen.getByRole("button", { name: "Retry live updates" }).focus();
    view.rerender(content(retrying));
    expect(notice()).toHaveTextContent(reason ?? "");
    expect(
      screen.getByRole("button", { name: "Retry live updates" }),
    ).toHaveFocus();
    view.rerender(content(failed));
    view.rerender(content(retrying));
    expect(onRecovered).not.toHaveBeenCalled();
    view.rerender(content(base));
    expect(notice()).not.toBeInTheDocument();
    expect(onRecovered).toHaveBeenCalledTimes(1);
    // Success ends the hold: a later attempt alone offers no Retry.
    view.rerender(content(retrying));
    expect(
      screen.queryByRole("button", { name: "Retry live updates" }),
    ).not.toBeInTheDocument();
    // Focus the user moved elsewhere stays there.
    const elsewhere = document.createElement("button");
    document.body.append(elsewhere);
    try {
      view.rerender(content(failed));
      screen.getByRole("button", { name: "Retry live updates" }).focus();
      elsewhere.focus();
      view.rerender(content(base));
      expect(onRecovered).toHaveBeenCalledTimes(1);
      expect(document.activeElement).toBe(elsewhere);
    } finally {
      elsewhere.remove();
    }
  },
);

it.each([
  ["roster", { roster: { state: "pending" } }],
  ["head", { heads: [{ channelId: "a", state: "pending" }] }],
] as const)(
  "keeps a focused Retry while a routine %s refresh runs",
  (_, refresh) => {
    const failed: Snapshot = {
      ...base,
      routes: [
        { ...channel, status: "error", error: "blocked: channel archived" },
      ],
    };
    const onRecovered = vi.fn();
    const content = (view: Snapshot) => (
      <LiveStatus
        live={{
          snapshot: () => view,
          subscribe: () => () => {},
          retry: vi.fn(),
        }}
        channelId="a"
        partialRoster={false}
        recovery={recoveryIn("idle")}
        onRecovered={onRecovered}
      />
    );
    const view = mount(content(failed));
    const retry = screen.getByRole("button", { name: "Retry live updates" });
    retry.focus();
    view.rerender(content({ ...failed, ...refresh } as Snapshot));
    expect(retry.isConnected).toBe(true);
    expect(retry).toHaveFocus();
    view.rerender(content(failed));
    expect(retry).toHaveFocus();
    expect(onRecovered).not.toHaveBeenCalled();
  },
);

it.each([
  [
    "another channel's route is pending",
    {
      routes: [
        channel,
        { ...channel, id: "channel:b", channelId: "b", status: "pending" },
      ],
    },
  ],
  [
    "another channel's head is pending",
    { heads: [{ channelId: "b", state: "pending" }] },
  ],
  [
    "another channel's route has a transient error",
    {
      routes: [
        channel,
        {
          ...channel,
          id: "channel:b",
          channelId: "b",
          status: "error",
          error: "temporary: relay busy",
        },
      ],
    },
  ],
  ["previews are being checked", { previews: "checking" }],
] as const)(
  "ends the held notice when this channel recovers while %s",
  (_, elsewhere) => {
    const failed: Snapshot = {
      ...base,
      routes: [
        { ...channel, status: "error", error: "blocked: channel archived" },
      ],
    };
    const onRecovered = vi.fn();
    const content = (view: Snapshot) => (
      <LiveStatus
        live={{
          snapshot: () => view,
          subscribe: () => () => {},
          retry: vi.fn(),
        }}
        channelId="a"
        partialRoster={false}
        recovery={recoveryIn("idle")}
        onRecovered={onRecovered}
      />
    );
    const view = mount(content(failed));
    screen.getByRole("button", { name: "Retry live updates" }).focus();
    view.rerender(content({ ...base, ...elsewhere } as Snapshot));
    expect(
      screen.queryByRole("status", { name: "Live updates limited" }),
    ).not.toBeInTheDocument();
    expect(onRecovered).toHaveBeenCalledTimes(1);
  },
);

const pendingB = {
  ...channel,
  id: "channel:b",
  channelId: "b",
  status: "pending",
} as const;
it.each([
  [
    "a partial roster while another route is pending",
    true,
    { routes: [channel, pendingB] },
  ],
  [
    "a partial roster while another route has a transient error",
    true,
    {
      routes: [
        channel,
        { ...pendingB, status: "error", error: "temporary: relay busy" },
      ],
    },
  ],
  [
    "capacity while another route is pending",
    false,
    {
      routes: [
        {
          ...channel,
          status: "limited",
          error: "Live channel capacity reached; finite reads remain available",
        },
        pendingB,
      ],
    },
  ],
] as const)(
  "drops the held Retry when this channel recovers to %s",
  (_, partialRoster, recovered) => {
    const failed: Snapshot = {
      ...base,
      routes: [
        { ...channel, status: "error", error: "blocked: channel archived" },
      ],
    };
    const content = (view: Snapshot) => (
      <LiveStatus
        live={{
          snapshot: () => view,
          subscribe: () => () => {},
          retry: vi.fn(),
        }}
        channelId="a"
        partialRoster={partialRoster}
        recovery={recoveryIn("idle")}
      />
    );
    const view = mount(content(failed));
    expect(
      screen.getByRole("button", { name: "Retry live updates" }),
    ).toBeVisible();
    view.rerender(content({ ...base, ...recovered } as Snapshot));
    expect(
      screen.getByRole("status", { name: "Live updates limited" }),
    ).not.toHaveTextContent("blocked: channel archived");
    expect(
      screen.queryByRole("button", { name: "Retry live updates" }),
    ).not.toBeInTheDocument();
  },
);

it("keeps capacity and partial-roster notices passive", () => {
  const capacity: Snapshot = {
    ...base,
    routes: [
      {
        id: "channel:a",
        channelId: "a",
        status: "limited",
        replay: "unknown",
        error: "Live channel capacity reached; finite reads remain available",
      },
    ],
  };
  const live = {
    snapshot: () => capacity,
    subscribe: () => () => {},
    retry: vi.fn(),
  };
  const view = mount(
    <LiveStatus live={live} channelId="a" partialRoster={false} />,
  );
  expect(
    screen.getByRole("status", { name: "Live updates limited" }),
  ).toBeInTheDocument();
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
  view.rerender(
    <LiveStatus
      live={{ ...live, snapshot: () => base }}
      channelId="a"
      partialRoster
    />,
  );
  expect(
    screen.getByRole("status", { name: "Live updates limited" }),
  ).toHaveTextContent("Some channels are missing");
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
});
