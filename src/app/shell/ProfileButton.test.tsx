// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
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
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { AccountActionsService } from "../../features/account-actions/service";
import type { Communities } from "../../features/communities/service";
import { APPEARANCE_KEY, createAppearance } from "../../shared/theme/service";
import { ProfileButton } from "./ProfileButton";

const testAppearance = createAppearance(window);

afterEach(cleanup);

it("keeps the header cutout and menu status in sync with presence", () => {
  const listeners = new Set<() => void>();
  let presence = {
    status: "online" as "online" | "away" | "offline" | "unknown",
    preference: "auto",
  };
  const state = {
    profile: { name: "", picture: "" },
    viewer: "a".repeat(64),
    selected: "https://relay.test",
  };
  const connection = {
    status: "ready",
    viewer: state.viewer,
    session: {
      presence: {
        status: () => presence.status,
        limited: () => false,
        subscribe: (_key: string, listener: () => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      live: { subscribe: () => () => {}, snapshot: () => undefined },
    },
    scope: "",
  };
  const subscribe = () => () => {};
  const communities = {
    subscribe,
    snapshot: () => state,
    relay: { subscribe, snapshot: () => connection },
    presence: {
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      snapshot: () => intent,
      setPreference: () => {},
    },
  } as unknown as Communities;
  const intent = { status: "online", preference: "auto", error: undefined };
  const actions: readonly [] = [];
  const accountActions = {
    subscribe,
    snapshot: () => actions,
  } as unknown as AccountActionsService;

  render(
    <ProfileButton
      communities={communities}
      accountActions={accountActions}
      appearance={testAppearance}
      settingsSelected={false}
      onSettings={() => {}}
    />,
  );
  const button = screen.getByRole("button", { name: "Your profile" });
  expect(button).toHaveAttribute("data-icon-variant", "avatar");
  expect(button.querySelector(".buzz-avatar svg")).toBeInTheDocument();
  expect(button.querySelector(".buzz-avatar")).not.toHaveTextContent("?");
  expect(button.querySelector(".buzz-avatar-status")).toHaveAttribute(
    "data-status",
    "online",
  );
  fireEvent.click(button);
  expect(
    screen
      .getByRole("button", { name: "Availability: Online" })
      .closest("[data-status]"),
  ).toHaveAttribute("data-status", "online");

  for (const [status, label] of [
    ["away", "Away"],
    ["offline", "Offline"],
    ["unknown", "Status unavailable"],
  ] as const) {
    act(() => {
      presence = { ...presence, status };
      for (const listener of listeners) listener();
    });
    if (status === "unknown")
      expect(button.querySelector(".buzz-avatar-status")).not.toHaveAttribute(
        "data-status",
      );
    else
      expect(button.querySelector(".buzz-avatar-status")).toHaveAttribute(
        "data-status",
        status,
      );
    expect(
      screen
        .getByRole("button", { name: `Availability: ${label}` })
        .closest("[data-status]"),
    ).toHaveAttribute("data-status", status);
  }
});

it("checks observed Away despite automatic Online intent and dispatches checked-item commands", async () => {
  const user = userEvent.setup();
  const viewer = "a".repeat(64);
  const listeners = new Set<() => void>();
  let observed = "away";
  const subscribe = () => () => {};
  const state = {
    profile: { name: "", picture: "" },
    viewer,
    selected: "https://relay.test",
  };
  const intent = { status: "online", preference: "auto", error: undefined };
  const setPreference = vi.fn();
  const connection = {
    status: "ready",
    viewer,
    scope: "",
    session: {
      presence: {
        status: () => observed,
        limited: () => false,
        subscribe: (_key: string, listener: () => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      live: { subscribe, snapshot: () => undefined },
    },
  };
  const communities = {
    subscribe,
    snapshot: () => state,
    relay: { subscribe, snapshot: () => connection },
    presence: { subscribe, snapshot: () => intent, setPreference },
  } as unknown as Communities;
  const actions: readonly [] = [];
  const accountActions = {
    subscribe,
    snapshot: () => actions,
  } as unknown as AccountActionsService;
  render(
    <ProfileButton
      communities={communities}
      accountActions={accountActions}
      appearance={testAppearance}
      settingsSelected={false}
      onSettings={() => {}}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Your profile" }));
  await user.click(
    await screen.findByRole("button", { name: "Availability: Away" }),
  );
  expect(
    await screen.findByRole("menuitemradio", { name: "Online" }),
  ).not.toBeChecked();
  const away = await screen.findByRole("menuitemradio", { name: "Away" });
  expect(away).toBeChecked();
  act(() => {
    observed = "unknown";
    for (const listener of listeners) listener();
  });
  for (const item of screen.getAllByRole("menuitemradio"))
    expect(item).not.toBeChecked();
  act(() => {
    observed = "away";
    for (const listener of listeners) listener();
  });
  expect(away).toBeChecked();
  await user.click(away);
  expect(setPreference).toHaveBeenCalledExactlyOnceWith("away");
  // Command dispatch is not evidence. The control remains Away until observed.
  expect(
    screen.getByRole("button", { name: "Availability: Away" }),
  ).toBeVisible();
});

it.each([false, true])(
  "hands Settings focus over after closing without stealing early page focus (%s)",
  async (earlyFocus) => {
    const user = userEvent.setup();
    const snapshot = {
      profile: { name: "Fixture", picture: "" },
      viewer: null,
    };
    const connection = { status: "unavailable", session: undefined, scope: "" };
    const presence = { status: "online", preference: "auto", error: null };
    const subscribe = () => () => {};
    const actions: readonly [] = [];
    const accountActions = {
      subscribe,
      snapshot: () => actions,
    } as unknown as AccountActionsService;
    const communities = {
      subscribe,
      snapshot: () => snapshot,
      presence: { subscribe, snapshot: () => presence },
      relay: { subscribe, snapshot: () => connection },
    } as unknown as Communities;
    function Shell() {
      const [settings, setSettings] = useState(false);
      return (
        <>
          <ProfileButton
            communities={communities}
            accountActions={accountActions}
            appearance={testAppearance}
            settingsSelected={settings}
            onSettings={() => setSettings(true)}
          />
          <main id="main-content" tabIndex={-1}>
            {settings && <input aria-label="Display name" />}
          </main>
        </>
      );
    }
    render(<Shell />);
    await user.click(screen.getByRole("button", { name: "Your profile" }));
    const menu = await screen.findByRole("menu", { name: "Fixture" });
    let release!: () => void;
    const finished = new Promise<void>((resolve) => {
      release = resolve;
    });
    const animations = vi.fn(() => [{ finished }]);
    // Hold the real menu's close-completion boundary, not a guessed delay or
    // a replacement React lifecycle. The production callback runs on release.
    Object.defineProperty(menu, "getAnimations", { value: animations });
    try {
      await user.click(screen.getByRole("menuitem", { name: "Settings" }));
      await waitFor(() => expect(animations).toHaveBeenCalled());
      expect(menu).toBeInTheDocument();
      const input = screen.getByRole("textbox", { name: "Display name" });
      if (earlyFocus) await user.type(input, "Do not save");
      await act(async () => release());
      await waitFor(() => expect(menu).not.toBeInTheDocument());
      expect(earlyFocus ? input : screen.getByRole("main")).toHaveFocus();
      if (earlyFocus) expect(input).toHaveValue("Do not save");
    } finally {
      await act(async () => release());
    }
  },
);

it("opens profile settings from the header, selects appearance in a submenu, and opens Plugins", async () => {
  const user = userEvent.setup();
  const snapshot = {
    profile: { name: "Fixture", picture: "" },
    viewer: "a".repeat(64),
  };
  const connection = { status: "unavailable", session: undefined, scope: "" };
  const presence = { status: "online", preference: "auto", error: null };
  const subscribe = () => () => {};
  const actions: readonly [] = [];
  const accountActions = {
    subscribe,
    snapshot: () => actions,
  } as unknown as AccountActionsService;
  const communities = {
    subscribe,
    snapshot: () => snapshot,
    presence: { subscribe, snapshot: () => presence },
    relay: { subscribe, snapshot: () => connection },
  } as unknown as Communities;
  localStorage.clear();
  const appearance = createAppearance(window);
  const onSettings = vi.fn();
  render(
    <>
      <ProfileButton
        communities={communities}
        accountActions={accountActions}
        appearance={appearance}
        settingsSelected={false}
        onSettings={onSettings}
      />
      <main id="main-content" tabIndex={-1} />
    </>,
  );
  const trigger = screen.getByRole("button", { name: "Your profile" });
  act(() => trigger.focus());
  await user.keyboard("{Enter}");
  const menu = await screen.findByRole("menu", { name: "Fixture" });
  // The header avatar is the first item and leads to profile settings.
  const header = screen.getByRole("menuitem", {
    name: "Fixture, edit profile",
  });
  await waitFor(() => expect(header).toHaveFocus());

  const appearanceRow = screen.getByRole("menuitem", { name: "Appearance" });
  expect(appearanceRow).toHaveAttribute("aria-haspopup", "menu");
  act(() => appearanceRow.focus());
  await user.keyboard("{ArrowRight}");
  const submenu = await screen.findByRole("menu", { name: "Appearance" });
  expect(appearance.snapshot().preference).toBe("system");
  expect(
    within(submenu).getByRole("menuitemradio", { name: "System" }),
  ).toBeChecked();
  const light = within(submenu).getByRole("menuitemradio", { name: "Light" });
  await user.click(light);
  expect(appearance.snapshot().preference).toBe("light");
  expect(light).toBeChecked();
  expect(
    within(submenu).getByRole("menuitemradio", { name: "System" }),
  ).not.toBeChecked();
  await user.keyboard("{ArrowDown}{Enter}");
  expect(appearance.snapshot().preference).toBe("dark");
  expect(
    within(submenu).getByRole("menuitemradio", { name: "Dark" }),
  ).toBeChecked();
  await user.click(
    within(submenu).getByRole("menuitemradio", { name: "System" }),
  );
  expect(appearance.snapshot().preference).toBe("system");
  expect(
    within(submenu).getByRole("menuitemradio", { name: "System" }),
  ).toBeChecked();
  const storage = vi.spyOn(Storage.prototype, "setItem");
  storage.mockImplementation(() => {
    throw new Error("Storage unavailable");
  });
  await user.click(light);
  expect(within(submenu).getByRole("alert")).toHaveTextContent(
    "This appearance is active, but could not be saved on this device. Try again.",
  );
  storage.mockRestore();
  await user.click(light);
  expect(within(submenu).queryByRole("alert")).not.toBeInTheDocument();
  expect(localStorage.getItem(APPEARANCE_KEY)).toBe("light");
  const restored = createAppearance(window);
  expect(restored.snapshot().preference).toBe("light");
  restored.dispose();
  await user.keyboard("{Escape}");
  await waitFor(() => expect(submenu).not.toBeInTheDocument());
  expect(appearanceRow).toHaveFocus();
  expect(menu).toBeInTheDocument();

  await user.click(
    screen.getByRole("menuitem", { name: "Fixture, edit profile" }),
  );
  expect(onSettings).toHaveBeenLastCalledWith("profile");
  await waitFor(() => expect(menu).not.toBeInTheDocument());
  await waitFor(() => expect(screen.getByRole("main")).toHaveFocus());

  await user.click(trigger);
  await screen.findByRole("menu", { name: "Fixture" });
  await user.click(screen.getByRole("menuitem", { name: "Plugins" }));
  expect(onSettings).toHaveBeenLastCalledWith("plugins");
  appearance.dispose();
});

it("shows the selected community name and authenticated avatar without saving a local default", async () => {
  const { createRelaySession } = await import("../../features/relay/session");
  const owner = createRelaySession(null);
  const user = userEvent.setup();
  const viewer = "a".repeat(64);
  let profiles = new Map<string, { name: string; picture?: string }>();
  const listeners = new Set<() => void>();
  const media = vi.fn(
    (url: string) => `/community-media?url=${encodeURIComponent(url)}`,
  );
  const ensure = vi.fn(async () => {});
  const connection = {
    viewer,
    status: "ready",
    session: {
      ...owner.session,
      media,
      profiles: {
        snapshot: () => profiles,
        subscribe: (listener: () => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        ensure,
      },
    },
  };
  const snapshot = {
    profile: { name: "Local name", picture: "" },
    viewer,
    selected: "https://community.test",
  };
  const presence = { status: "online", preference: "auto", error: null };
  const subscribe = () => () => {};
  const actions: readonly [] = [];
  const accountActions = {
    subscribe,
    snapshot: () => actions,
  } as unknown as AccountActionsService;
  const communities = {
    subscribe,
    snapshot: () => snapshot,
    presence: { subscribe, snapshot: () => presence },
    relay: { subscribe, snapshot: () => connection },
  } as unknown as Communities;
  const view = render(
    <ProfileButton
      communities={communities}
      accountActions={accountActions}
      appearance={testAppearance}
      settingsSelected={false}
      onSettings={() => {}}
    />,
  );
  try {
    expect(
      screen.getByRole("button", { name: "Your profile" }),
    ).toBeInTheDocument();
    act(() => {
      profiles = new Map([
        [
          viewer,
          {
            name: "Community name",
            picture: "https://community.test/media/avatar.png",
          },
        ],
      ]);
      for (const listener of listeners) listener();
    });
    await user.click(screen.getByRole("button", { name: "Your profile" }));
    expect(
      await screen.findByRole("menu", { name: "Community name" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Availability: Status unavailable" }),
    ).toBeVisible();
    expect(media).toHaveBeenCalledWith(
      "https://community.test/media/avatar.png",
      "small",
    );
    const button = screen.getByRole("button", { name: "Your profile" });
    expect(screen.getByRole("menu", { name: "Community name" })).toBeVisible();
    expect(button.querySelector("img")).toHaveAttribute(
      "src",
      "/community-media?url=https%3A%2F%2Fcommunity.test%2Fmedia%2Favatar.png",
    );
    act(() => {
      profiles = new Map([[viewer, { name: "Updated name" }]]);
      for (const listener of listeners) listener();
    });
    expect(screen.getByRole("menu", { name: "Updated name" })).toBeVisible();
    expect(button.querySelector("img")).toBeNull();
    expect(snapshot.profile).toEqual({ name: "Local name", picture: "" });
    expect(screen.queryByText("Your profile")).not.toBeInTheDocument();
    expect(screen.queryByText("Your account")).not.toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "Set a status" }),
    ).toHaveAttribute("aria-disabled", "true");
    expect(
      screen.getByText("Status updates are unavailable in this community."),
    ).toBeVisible();
  } finally {
    view.unmount();
    owner.dispose();
  }
});

it.each(["escape", "close button", "reopen", "scope switch"])(
  "opens status immediately and ignores a held refresh after %s dismissal",
  async (dismiss) => {
    const { createRelaySession } = await import("../../features/relay/session");
    const owner = createRelaySession(null);
    const user = userEvent.setup();
    let release!: () => void;
    const current = vi.fn(
      () =>
        new Promise<undefined>((resolve) => {
          release = () => resolve(undefined);
        }),
    );
    const viewer = "a".repeat(64);
    let connection = {
      scope: "https://status.test",
      session: {
        ...owner.session,
        statuses: { ...owner.session.statuses, writable: true, current },
      },
    };
    const snapshot = {
      profile: { name: "Local", picture: "http://unsafe.test/avatar" },
      viewer,
    };
    const presence = { status: "online", preference: "auto", error: null };
    const listeners = new Set<() => void>();
    const subscribe = (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    };
    const actions: readonly [] = [];
    const accountActions = {
      subscribe,
      snapshot: () => actions,
    } as unknown as AccountActionsService;
    const communities = {
      subscribe,
      snapshot: () => snapshot,
      presence: { subscribe, snapshot: () => presence },
      relay: { subscribe, snapshot: () => connection },
    } as unknown as Communities;
    const view = render(
      <>
        <ProfileButton
          communities={communities}
          accountActions={accountActions}
          appearance={testAppearance}
          settingsSelected={false}
          onSettings={() => {}}
        />
        <button type="button">Outside</button>
      </>,
    );
    try {
      expect(view.container.querySelector('img[src^="http:"]')).toBeNull();
      act(() => screen.getByRole("button", { name: "Your profile" }).focus());
      await user.keyboard("{Enter}");
      await screen.findByRole("menu", { name: "Local" });
      await user.click(screen.getByRole("menuitem", { name: "Set a status" }));
      expect(current).toHaveBeenCalledOnce();
      expect(
        screen.getByRole("dialog", { name: "Set a status" }),
      ).toBeVisible();
      if (dismiss === "scope switch") {
        const original = connection;
        act(() => {
          connection = { ...original, session: { ...original.session } };
          for (const listener of listeners) listener();
        });
        act(() => {
          connection = original;
          for (const listener of listeners) listener();
        });
      } else if (dismiss === "close button")
        await user.click(
          screen.getByRole("button", { name: "Close status editor" }),
        );
      else await user.keyboard("{Escape}");
      await waitFor(() =>
        expect(
          screen.queryByRole("menu", { name: "Local" }),
        ).not.toBeInTheDocument(),
      );
      if (dismiss === "reopen") {
        act(() => screen.getByRole("button", { name: "Your profile" }).focus());
        await user.keyboard("{Enter}");
        await screen.findByRole("menu", { name: "Local" });
      }
      await act(async () => release());
      expect(
        screen.queryByRole("dialog", { name: "Set a status" }),
      ).not.toBeInTheDocument();
      if (dismiss === "reopen")
        expect(screen.getByRole("menu", { name: "Local" })).toBeVisible();
    } finally {
      await act(async () => release?.());
      view.unmount();
      owner.dispose();
    }
  },
);

it("names the status emoji on hover in the menu's status row", async () => {
  const { createRelaySession } = await import("../../features/relay/session");
  const owner = createRelaySession(null);
  const user = userEvent.setup();
  const viewer = "a".repeat(64);
  const statuses = new Map([
    [viewer, { userId: viewer, text: "Buzzin'", emoji: "🏠", updatedAt: 1 }],
  ]);
  const connection = {
    scope: "https://status.test",
    session: {
      ...owner.session,
      statuses: { ...owner.session.statuses, snapshot: () => statuses },
    },
  };
  const snapshot = { profile: { name: "Local", picture: "" }, viewer };
  const presence = { status: "online", preference: "auto", error: null };
  const subscribe = () => () => {};
  const actions: readonly [] = [];
  const view = render(
    <ProfileButton
      communities={
        {
          subscribe,
          snapshot: () => snapshot,
          presence: { subscribe, snapshot: () => presence },
          relay: { subscribe, snapshot: () => connection },
        } as unknown as Communities
      }
      accountActions={
        {
          subscribe,
          snapshot: () => actions,
        } as unknown as AccountActionsService
      }
      appearance={testAppearance}
      settingsSelected={false}
      onSettings={() => {}}
    />,
  );
  try {
    await user.click(screen.getByRole("button", { name: "Your profile" }));
    await screen.findByRole("menu", { name: "Local" });
    const row = screen.getByRole("menuitem", {
      name: "Set a status: 🏠 Buzzin'",
    });
    await user.hover(within(row).getByText("🏠"));
    expect(await screen.findByRole("tooltip")).toHaveTextContent(/^:house:$/);
    expect(row).toHaveAttribute("data-highlighted");
  } finally {
    view.unmount();
    owner.dispose();
  }
});

it.each(["online", "offline"] as const)(
  "shares %s presence between trigger and account menu",
  async (status) => {
    const user = userEvent.setup();
    const snapshot = {
      profile: { name: "Fixture", picture: "" },
      viewer: "fixture",
      selected: "https://relay.test",
    };
    const presence = {
      status,
      preference: status === "offline" ? "offline" : "auto",
      error: null,
    };
    const setPreference = vi.fn();
    const profileMap = new Map([["fixture", { name: "Fixture", picture: "" }]]);
    const connection = {
      status: "ready",
      viewer: "fixture",
      session: {
        profiles: { subscribe: () => () => {}, snapshot: () => profileMap },
        presence: {
          status: () => status,
          limited: () => false,
          subscribe: () => () => {},
        },
        live: { subscribe: () => () => {}, snapshot: () => undefined },
      },
      scope: "",
    };
    const subscribe = () => () => {};
    const actions: readonly [] = [];
    const accountActions = {
      subscribe,
      snapshot: () => actions,
    } as unknown as AccountActionsService;
    const communities = {
      subscribe,
      snapshot: () => snapshot,
      presence: { subscribe, snapshot: () => presence, setPreference },
      relay: { subscribe, snapshot: () => connection },
    } as unknown as Communities;
    render(
      <ProfileButton
        communities={communities}
        accountActions={accountActions}
        appearance={testAppearance}
        settingsSelected={false}
        onSettings={() => {}}
      />,
    );
    const label = `Your status: ${{ online: "Online", away: "Away", offline: "Offline" }[status]}`;
    expect(screen.getAllByRole("img", { name: label })).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Your profile" }));
    const menu = await screen.findByRole("menu", { name: "Fixture" });
    expect(
      menu.querySelector(
        `.buzz-avatar-status[data-status="${status}"] .buzz-avatar-status-dot[aria-hidden="true"]`,
      ),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: /^Availability:/ }),
    ).toHaveTextContent(
      { online: "Online", away: "Away", offline: "Offline" }[status],
    );
    await user.click(screen.getByRole("button", { name: /^Availability:/ }));
    expect(
      (await screen.findAllByRole("menuitemradio")).map(
        (item) => item.textContent,
      ),
    ).toEqual(["Online", "Away", "Offline"]);
    expect(
      screen.getByRole("menuitemradio", {
        name: { online: "Online", away: "Away", offline: "Offline" }[status],
      }),
    ).toBeChecked();
    const next = status === "offline" ? "Online" : "Offline";
    await user.click(screen.getByRole("menuitemradio", { name: next }));
    expect(setPreference).toHaveBeenCalledWith(next.toLowerCase());
  },
);

it("drops the previous community profile on switching and uses local defaults only in Personal space", async () => {
  const { createRelaySession } = await import("../../features/relay/session");
  const owner = createRelaySession(null);
  const viewer = "a".repeat(64);
  const listeners = new Set<() => void>();
  const oldListeners = new Set<() => void>();
  let oldProfile = { name: "Alpha", picture: "https://alpha.test/avatar.png" };
  const alphaProfiles = {
    snapshot: () => new Map([[viewer, oldProfile]]),
    subscribe: (listener: () => void) => {
      oldListeners.add(listener);
      return () => {
        oldListeners.delete(listener);
      };
    },
    ensure: vi.fn(async () => {}),
  };
  let state = {
    viewer,
    selected: "https://alpha.test" as string | null,
    profile: {
      name: "Personal name",
      picture: "https://public.test/local.png",
    },
  };
  let connection = {
    viewer,
    status: "ready",
    session: {
      ...owner.session,
      profiles: alphaProfiles,
      media: (url: string) => url,
    },
  };
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const presence = { status: "online", preference: "auto", error: null };
  const communities = {
    subscribe,
    snapshot: () => state,
    presence: { subscribe, snapshot: () => presence },
    relay: { subscribe, snapshot: () => connection },
  } as unknown as Communities;
  const actions: readonly [] = [];
  const accountActions = {
    subscribe: () => () => {},
    snapshot: () => actions,
  } as unknown as AccountActionsService;
  const view = render(
    <ProfileButton
      communities={communities}
      accountActions={accountActions}
      appearance={testAppearance}
      settingsSelected={false}
      onSettings={() => {}}
    />,
  );
  try {
    const button = screen.getByRole("button", { name: "Your profile" });
    fireEvent.click(button);
    expect(await screen.findByRole("menu", { name: "Alpha" })).toBeVisible();
    expect(button.querySelector("img")).toHaveAttribute(
      "src",
      oldProfile.picture,
    );
    act(() => {
      state = { ...state, selected: "https://beta.test" };
      connection = {
        ...connection,
        session: {
          ...connection.session,
          profiles: {
            ...alphaProfiles,
            snapshot: () => new Map(),
            subscribe: () => () => {},
          },
        },
      };
      for (const listener of listeners) listener();
    });
    expect(screen.getByRole("menu")).not.toHaveAccessibleName("Alpha");
    expect(screen.getByRole("menu")).not.toHaveAccessibleName("Personal name");
    expect(button.querySelector("img")).toBeNull();
    act(() => {
      oldProfile = { ...oldProfile, name: "Late Alpha" };
      for (const listener of oldListeners) listener();
    });
    expect(oldListeners.size).toBe(0);
    expect(screen.getByRole("menu")).not.toHaveAccessibleName("Late Alpha");
    expect(button.querySelector("img")).toBeNull();
    act(() => {
      state = { ...state, selected: null };
      for (const listener of listeners) listener();
    });
    expect(screen.getByRole("menu", { name: "Personal name" })).toBeVisible();
    expect(button.querySelector("img")).toHaveAttribute(
      "src",
      "https://public.test/local.png",
    );
  } finally {
    view.unmount();
    owner.dispose();
  }
});

it("refreshes the viewer through the real session after roster setup, not a stale cache", async () => {
  const { createRelaySession } = await import("../../features/relay/session");
  const { keypair, metadata, profile, roster, scriptedTransport } =
    await import("../../features/relay/testing");
  const viewer = keypair();
  const relay = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live!: import("../../features/relay/live").LiveCallbacks;
  const owner = createRelaySession({
    ...wire.transport,
    subscribe(callbacks) {
      live = callbacks;
      return { update() {}, retry() {}, dispose() {} };
    },
  });
  live.state({ status: "connected", routes: [] });
  owner.session.channels.ensureList();
  const initialRoster = wire.next();
  const read = vi.fn(owner.session.read);
  const connection = {
    viewer: viewer.pubkey,
    status: "ready",
    session: { ...owner.session, read },
  };
  const snapshot = {
    viewer: viewer.pubkey,
    selected: "https://community.test",
    profile: { name: "Local only", picture: "" },
  };
  const presence = { status: "online", preference: "auto", error: null };
  const subscribe = () => () => {};
  const communities = {
    subscribe,
    snapshot: () => snapshot,
    presence: { subscribe, snapshot: () => presence },
    relay: { subscribe, snapshot: () => connection },
  } as unknown as Communities;
  const actions: readonly [] = [];
  const accountActions = {
    subscribe: () => () => {},
    snapshot: () => actions,
  } as unknown as AccountActionsService;
  const view = render(
    <ProfileButton
      communities={communities}
      accountActions={accountActions}
      appearance={testAppearance}
      settingsSelected={false}
      onSettings={() => {}}
    />,
  );
  try {
    expect(wire.pending).toHaveLength(0);
    await act(async () => {
      initialRoster.respond([
        roster(relay, "a", [viewer.pubkey]),
        metadata(relay, "a", "A"),
      ]);
    });
    await waitFor(() =>
      expect(owner.session.live.snapshot().roster.state).toBe("verified"),
    );
    await waitFor(() =>
      expect(read).toHaveBeenCalledWith(
        [{ kinds: [0], authors: [viewer.pubkey], limit: 5 }],
        expect.objectContaining({
          priority: "background",
          fresh: true,
          signal: expect.any(AbortSignal),
        }),
      ),
    );
    // Status enrichment shares the background lane; finish it before the avatar read.
    await act(async () => {
      for (const request of wire.pending.filter(
        (entry) => entry.filters[0]?.kinds?.[0] !== 0,
      ))
        request.respond([]);
    });
    await waitFor(() =>
      expect(
        wire.pending.some((entry) => entry.filters[0]?.kinds?.[0] === 0),
      ).toBe(true),
    );
    const lookup = wire.pending.find(
      (entry) => entry.filters[0]?.kinds?.[0] === 0,
    );
    if (!lookup) throw new Error("Missing profile read");
    // A disk/live cached record arriving during the fresh read must not suppress it.
    act(() => live.receive([profile(viewer, { name: "Old cached name" })]));
    fireEvent.click(screen.getByRole("button", { name: "Your profile" }));
    await waitFor(() =>
      expect(
        screen.getByRole("menu", { name: "Old cached name" }),
      ).toBeVisible(),
    );
    await act(async () =>
      lookup.respond([
        profile(viewer, { name: "Current community name" }, 1_700_000_001),
      ]),
    );
    expect(
      await screen.findByRole("menu", { name: "Current community name" }),
    ).toBeVisible();
    expect(snapshot.profile.name).toBe("Local only");
    // Unrelated live notifications do not start extra reads.
    act(() => live.state({ status: "connected", routes: [] }));
    expect(read).toHaveBeenCalledTimes(1);
  } finally {
    view.unmount();
    owner.dispose();
  }
});

it.each(["default", "before-settings"] as const)(
  "opens a contributed %s action in host menu order and removes retired registrations",
  async (placement) => {
    const user = userEvent.setup();
    const profile = { profile: { name: "Fixture", picture: "" }, viewer: null };
    const presence = { status: "online", preference: "auto", error: null };
    const subscribe = () => () => {};
    const connection = { status: "unavailable", session: undefined, scope: "" };
    const communities = {
      subscribe,
      snapshot: () => profile,
      presence: { subscribe, snapshot: () => presence },
      relay: { subscribe, snapshot: () => connection },
    } as unknown as Communities;
    function Action({
      open,
      onOpenChange,
    }: {
      open: boolean;
      onOpenChange(open: boolean): void;
    }) {
      return open ? (
        <div role="dialog" aria-label="Feedback">
          <button type="button" onClick={() => onOpenChange(false)}>
            Dismiss feedback
          </button>
        </div>
      ) : null;
    }
    const entry = {
      placement,
      key: "buzz.feedback/send",
      pluginId: "buzz.feedback",
      title: "Send feedback",
      component: Action,
    };
    let actions = [entry];
    const listeners = new Set<() => void>();
    const accountActions = {
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      snapshot: () => actions,
    } as unknown as AccountActionsService;
    render(
      <ProfileButton
        communities={communities}
        accountActions={accountActions}
        appearance={testAppearance}
        settingsSelected={false}
        onSettings={() => {}}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Your profile" }));
    const menu = await screen.findByRole("menu", { name: "Fixture" });
    expect(within(menu).getAllByRole("separator")).toHaveLength(
      placement === "default" ? 2 : 1,
    );
    const items = within(menu).getAllByRole("menuitem");
    const feedback = await screen.findByRole("menuitem", {
      name: "Send feedback",
    });
    const settings = within(menu).getByRole("menuitem", { name: "Settings" });
    expect(items.indexOf(feedback) - items.indexOf(settings)).toBe(
      placement === "default" ? 1 : -1,
    );
    feedback.focus();
    await user.keyboard("{Enter}");
    expect(
      screen.getByRole("dialog", { name: "Feedback" }),
    ).toBeInTheDocument();
    await act(async () => {
      actions = [];
      for (const listener of listeners) listener();
    });
    expect(
      screen.queryByRole("dialog", { name: "Feedback" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Your profile" }));
    expect(
      screen.queryByRole("menuitem", { name: "Send feedback" }),
    ).not.toBeInTheDocument();
    expect(
      within(await screen.findByRole("menu", { name: "Fixture" })).getAllByRole(
        "separator",
      ),
    ).toHaveLength(1);
  },
);

async function statusFeedbackFixture(disconnected = false) {
  const listeners = new Set<() => void>();
  let observed = "online";
  let state = {
    viewer: "a".repeat(64),
    selected: "https://first.test",
    profile: { name: "Fixture" },
  };
  const subscribe = (fn: () => void) => {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  };
  const connection = {
    status: disconnected ? "error" : "ready",
    viewer: state.viewer,
    session: disconnected
      ? undefined
      : {
          presence: {
            status: () => observed,
            limited: () => false,
            subscribe: (_key: string, fn: () => void) => subscribe(fn),
          },
          live: { subscribe: () => () => {}, snapshot: () => undefined },
        },
  };
  const intent = { status: "online", preference: "auto" };
  const setPreference = vi.fn();
  const actions: readonly [] = [];
  render(
    <ProfileButton
      appearance={testAppearance}
      communities={
        {
          subscribe,
          snapshot: () => state,
          relay: { subscribe, snapshot: () => connection },
          presence: { subscribe, snapshot: () => intent, setPreference },
        } as unknown as Communities
      }
      accountActions={
        {
          subscribe,
          snapshot: () => actions,
        } as unknown as AccountActionsService
      }
      settingsSelected={false}
      onSettings={() => {}}
    />,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Your profile" }));
  await user.click(
    await screen.findByRole("button", { name: /^Availability:/ }),
  );
  await screen.findByRole("menuitemradio", { name: "Away" });
  return {
    setPreference,
    observe(status: string) {
      act(() => {
        observed = status;
        for (const fn of listeners) fn();
      });
    },
    community() {
      act(() => {
        state = { ...state, selected: "https://second.test" };
        for (const fn of listeners) fn();
      });
    },
  };
}

it("keeps confirmed indicators while pending, replaces attempts, times out, retries and clears late success", async () => {
  const h = await statusFeedbackFixture();
  vi.useFakeTimers();
  try {
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Away" }));
    expect(screen.getByRole("status")).toHaveTextContent("Updating to away");
    expect(screen.getByRole("menuitemradio", { name: "Online" })).toBeChecked();
    expect(
      screen
        .getByRole("button", { name: "Your profile" })
        .querySelector(".buzz-avatar-status"),
    ).toHaveAttribute("data-status", "online");
    act(() => vi.advanceTimersByTime(10000));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Offline" }));
    act(() => vi.advanceTimersByTime(5000));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Updating to offline");
    h.observe("away"); // Late evidence for the superseded click cannot finish Offline.
    expect(screen.getByRole("status")).toHaveTextContent("Updating to offline");
    act(() => vi.advanceTimersByTime(9999));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Could not confirm your status",
    );
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Offline" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(15000));
    expect(screen.getByRole("alert")).toBeInTheDocument();
    h.observe("offline");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(
      screen.getByRole("menuitemradio", { name: "Offline" }),
    ).toBeChecked();
    expect(h.setPreference.mock.calls.map(([value]) => value)).toEqual([
      "away",
      "offline",
      "offline",
    ]);
  } finally {
    cleanup();
    vi.useRealTimers();
  }
});

it("cancels feedback on disconnected community switches even when both sessions are absent", async () => {
  const h = await statusFeedbackFixture(true);
  vi.useFakeTimers();
  try {
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Away" }));
    expect(screen.getByRole("status")).toBeInTheDocument();
    h.community();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(15000));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  } finally {
    cleanup();
    vi.useRealTimers();
  }
});

it.each([
  [0, null],
  [1, "1 recommended plugin"],
  [3, "3 recommended plugins"],
])(
  "points to %s managed plugin recommendations beside Plugins",
  async (count, text) => {
    const user = userEvent.setup();
    const subscribe = () => () => {};
    const actions: readonly [] = [];
    const state = { profile: { name: "Fixture", picture: "" }, viewer: null };
    const presence = { status: "online", preference: "auto" };
    const connection = { status: "unavailable", session: undefined, scope: "" };
    const communities = {
      subscribe,
      snapshot: () => state,
      presence: { subscribe, snapshot: () => presence },
      relay: { subscribe, snapshot: () => connection },
    } as unknown as Communities;
    render(
      <ProfileButton
        communities={communities}
        accountActions={
          {
            subscribe,
            snapshot: () => actions,
          } as unknown as AccountActionsService
        }
        appearance={testAppearance}
        settingsSelected={false}
        pluginRecommendations={count}
        onSettings={() => {}}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Your profile" }));
    const item = await screen.findByRole("menuitem", { name: /Plugins/ });
    if (text) expect(item).toHaveTextContent(text);
    else expect(item).not.toHaveTextContent("recommended");
  },
);
