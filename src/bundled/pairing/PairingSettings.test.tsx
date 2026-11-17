// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PairingSettings } from "./PairingSettings";
import type { ClientSnapshot } from "../../features/communities/service";
import type {
  PairingNative,
  PairingStatus,
} from "../../features/pairing/client";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
it.each([
  { live: "1", tauri: true, available: false },
  { live: "0", tauri: true, available: true },
  { live: "0", tauri: false, available: false },
])(
  "uses native identity availability (live: $live, tauri: $tauri)",
  ({ live, tauri, available }) => {
    vi.stubGlobal("isTauri", tauri);
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    vi.stubEnv("VITE_BUZZ_LIVE", live);
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }));
    const native = {
      account: vi.fn(async () => "a".repeat(64)),
      start: vi.fn(async () => {}),
      status: vi.fn(async (): Promise<PairingStatus> => ({ phase: "idle" })),
      cancel: vi.fn(
        async (): Promise<PairingStatus> => ({ phase: "cancelled" }),
      ),
      confirm: vi.fn(async () => {}),
      deny: vi.fn(async () => {}),
    } satisfies PairingNative;
    const snapshot: ClientSnapshot = {
      status: "ready",
      relayAvailable: true,
      viewer: "a".repeat(64),
      selected: null,
      profile: { name: "", picture: "" },
      memberships: [],
      sync: { known: [], outbox: [] },
    };
    render(
      <PairingSettings
        communities={{
          snapshot: () => snapshot,
          subscribe: () => () => {},
          retained: () => undefined,
        }}
        active={() => true}
        native={native}
      />,
    );
    if (available) {
      expect(
        screen.queryByText(/unavailable with the development broker/),
      ).toBeNull();
      expect(screen.getByLabelText("Community address")).toBeTruthy();
    } else {
      expect(screen.getByRole("status").textContent).toContain(
        tauri
          ? "unavailable with the development broker"
          : "Open the Buzz desktop app",
      );
      expect(screen.queryByLabelText("Community address")).toBeNull();
    }
    expect(native.account).not.toHaveBeenCalled();
    expect(native.start).not.toHaveBeenCalled();
  },
);
it.each([true, false])(
  "renews a committed manual destination and pairs another phone (known viewer: %s)",
  async (knownViewer) => {
    vi.useFakeTimers();
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }));
    const viewer = "a".repeat(64);
    const snapshot: ClientSnapshot = {
      status: "ready",
      relayAvailable: true,
      ...(knownViewer ? { viewer } : {}),
      selected: null,
      profile: { name: "", picture: "" },
      memberships: [],
      sync: { known: [], outbox: [] },
    };
    let status: PairingStatus = { phase: "idle" };
    const native = {
      account: vi.fn(async () => viewer),
      start: vi.fn<PairingNative["start"]>(async () => {
        status = { phase: "qr", svg: "<svg/>", uri: "nostrpair://fixture" };
      }),
      status: vi.fn(async () => status),
      cancel: vi.fn(
        async (): Promise<PairingStatus> => ({ phase: "cancelled" }),
      ),
      confirm: vi.fn(async () => {}),
      deny: vi.fn(async () => {}),
    } satisfies PairingNative;
    render(
      <PairingSettings
        communities={{
          snapshot: () => snapshot,
          subscribe: () => () => {},
          retained: () => undefined,
        }}
        active={() => true}
        available
        native={native}
      />,
    );
    if (!knownViewer)
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: "Use existing Buzz account" }),
        );
      });
    const input = screen.getByLabelText("Community address");
    fireEvent.change(input, { target: { value: "https://community.example" } });
    expect(native.start).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.blur(input);
    });
    expect(native.start).toHaveBeenCalledTimes(1);
    status = { phase: "expired" };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(native.start).toHaveBeenCalledTimes(2);
    expect(native.start.mock.calls[1]).toEqual([
      expect.any(String),
      viewer,
      "https://community.example",
    ]);
    status = { phase: "complete" };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Pair another phone" }),
      );
    });
    expect(native.start).toHaveBeenCalledTimes(3);
    expect(native.start.mock.calls[2]).toEqual([
      expect.any(String),
      viewer,
      "https://community.example",
    ]);
  },
);

it.each(["uncertain", "cancelled"] as const)(
  "keeps %s terminal until a deliberate new attempt",
  async (phase) => {
    vi.useFakeTimers();
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }));
    const viewer = "a".repeat(64);
    let snapshot: ClientSnapshot = {
      status: "ready",
      relayAvailable: true,
      viewer,
      selected: "https://community.example",
      profile: { name: "", picture: "" },
      memberships: [],
      sync: { known: [], outbox: [] },
    };
    let status: PairingStatus = { phase: "idle" };
    const native = {
      account: vi.fn(async () => viewer),
      start: vi.fn<PairingNative["start"]>(async () => {
        status = { phase: "qr", svg: "<svg/>", uri: "nostrpair://fixture" };
      }),
      status: vi.fn(async () => status),
      cancel: vi.fn(
        async (): Promise<PairingStatus> => ({ phase: "cancelled" }),
      ),
      confirm: vi.fn(async () => {}),
      deny: vi.fn(async () => {}),
    } satisfies PairingNative;
    let mounted!: ReturnType<typeof render>;
    const view = () => (
      <PairingSettings
        communities={{
          snapshot: () => snapshot,
          subscribe: () => () => {},
          retained: () => undefined,
        }}
        active={() => true}
        available
        native={native}
      />
    );
    await act(async () => {
      mounted = render(
        <PairingSettings
          communities={{
            snapshot: () => snapshot,
            subscribe: () => () => {},
            retained: () => undefined,
          }}
          active={() => true}
          available
          native={native}
        />,
      );
    });
    expect(native.start).toHaveBeenCalledTimes(1);
    // A selected community supplies the address instead of the manual field.
    expect(native.start.mock.calls[0]).toEqual([
      expect.any(String),
      viewer,
      "https://community.example",
    ]);
    expect(screen.queryByLabelText("Community address")).toBeNull();
    status = { phase: "transferring" };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    status = { phase };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    if (phase === "uncertain")
      expect(
        screen.getByRole("heading", { name: "Check your phone" }),
      ).toBeTruthy();
    expect(
      screen.queryByAltText("Scan this QR code with Buzz on your phone"),
    ).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(240000);
    });
    expect(native.start).toHaveBeenCalledTimes(1);
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", {
          name: phase === "uncertain" ? "Start a new pairing" : "Try again",
        }),
      );
    });
    expect(native.start).toHaveBeenCalledTimes(2);
    snapshot = {
      ...snapshot,
      viewer: "b".repeat(64),
      selected: "https://other.example",
    };
    await act(async () => {
      mounted.rerender(view());
    });
    expect(native.start).toHaveBeenCalledTimes(3);
    expect(native.start.mock.calls[2]).toEqual([
      expect.any(String),
      "b".repeat(64),
      "https://other.example",
    ]);
  },
);

it("copies the current QR and explains phone verification", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  const writeText = vi
    .fn<(text: string) => Promise<void>>()
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error("denied"));
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  const viewer = "a".repeat(64);
  const snapshot: ClientSnapshot = {
    status: "ready",
    relayAvailable: true,
    viewer,
    selected: "https://community.example",
    profile: { name: "", picture: "" },
    memberships: [],
    sync: { known: [], outbox: [] },
  };
  let status: PairingStatus = {
    phase: "qr",
    svg: "<svg/>",
    uri: "nostrpair://first",
  };
  const native = {
    account: vi.fn(async () => viewer),
    start: vi.fn(async () => {}),
    status: vi.fn(async () => status),
    confirm: vi.fn(async () => {}),
    deny: vi.fn(async () => {}),
    cancel: vi.fn(async (): Promise<PairingStatus> => ({ phase: "cancelled" })),
  } satisfies PairingNative;
  render(
    <PairingSettings
      communities={{
        snapshot: () => snapshot,
        subscribe: () => () => {},
        retained: () => undefined,
      }}
      active={() => true}
      available
      native={native}
    />,
  );
  await act(async () => {});
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Copy pairing code" }));
  });
  expect(writeText).toHaveBeenLastCalledWith("nostrpair://first");
  expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();

  status = { phase: "qr", svg: "<svg/>", uri: "nostrpair://second" };
  await act(async () => {
    await vi.advanceTimersByTimeAsync(400);
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Copy pairing code" }));
  });
  expect(writeText).toHaveBeenLastCalledWith("nostrpair://second");
  expect(
    screen.getByRole("button", { name: "Couldn’t copy. Try again" }),
  ).toBeTruthy();

  status = { phase: "code", code: "123456" };
  await act(async () => {
    await vi.advanceTimersByTimeAsync(400);
  });
  expect(screen.queryByRole("button", { name: /cop/i })).toBeNull();
  const instructions = screen.getByRole("list", { name: "Pairing steps" });
  const announcement = screen.getByText(/^Verification code 1 2 3 4 5 6\./);
  expect(announcement.getAttribute("aria-live")).toBe("polite");
  for (const surface of [instructions, announcement]) {
    expect(surface.textContent).toContain(
      "If your phone asks for a code, enter these digits and finish confirming on your phone.",
    );
    expect(surface.textContent).toContain(
      "If it shows a code, check that the digits match.",
    );
    expect(surface.textContent).toContain(
      "Then choose Codes match here to send your Buzz identity.",
    );
  }
});

it("rejects a mismatch and requires explicit retry", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  const viewer = "a".repeat(64);
  const snapshot: ClientSnapshot = {
    status: "ready",
    relayAvailable: true,
    viewer,
    selected: "https://community.example",
    profile: { name: "", picture: "" },
    memberships: [],
    sync: { known: [], outbox: [] },
  };
  let status: PairingStatus = {
    phase: "code",
    code: "123456",
  };
  const native = {
    account: vi.fn(async () => viewer),
    start: vi.fn(async () => {}),
    status: vi.fn(async () => status),
    confirm: vi.fn(async () => {}),
    deny: vi.fn(async () => {
      status = { phase: "error", message: "Codes did not match." };
    }),
    cancel: vi.fn(async (): Promise<PairingStatus> => ({ phase: "cancelled" })),
  } satisfies PairingNative;
  render(
    <PairingSettings
      communities={{
        snapshot: () => snapshot,
        subscribe: () => () => {},
        retained: () => undefined,
      }}
      active={() => true}
      available
      native={native}
    />,
  );
  await act(async () => {});
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await vi.advanceTimersByTimeAsync(400);
  });
  expect(native.deny).toHaveBeenCalledTimes(1);
  expect(native.confirm).not.toHaveBeenCalled();
  expect(screen.getByRole("alert").textContent).toContain(
    "Codes did not match",
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(240000);
  });
  expect(native.start).toHaveBeenCalledTimes(1);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  });
  expect(native.start).toHaveBeenCalledTimes(2);
});

it("keeps rejection progress truthful until native denial finishes", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  const viewer = "a".repeat(64);
  const snapshot: ClientSnapshot = {
    status: "ready",
    relayAvailable: true,
    viewer,
    selected: "https://community.example",
    profile: { name: "", picture: "" },
    memberships: [],
    sync: { known: [], outbox: [] },
  };
  let status: PairingStatus = {
    phase: "code",
    code: "123456",
  };
  const native = {
    account: vi.fn(async () => viewer),
    start: vi.fn(async () => {}),
    status: vi.fn(async () => status),
    confirm: vi.fn(async () => {}),
    deny: vi.fn(async () => {}),
    cancel: vi.fn(async (): Promise<PairingStatus> => ({ phase: "cancelled" })),
  } satisfies PairingNative;
  render(
    <PairingSettings
      communities={{
        snapshot: () => snapshot,
        subscribe: () => () => {},
        retained: () => undefined,
      }}
      active={() => true}
      available
      native={native}
    />,
  );
  try {
    await act(async () => {});
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    });
    expect(native.deny).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status").textContent).toContain(
      "Cancelling pairing",
    );
    expect(screen.queryByText("Creating pairing code…")).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(native.status).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("status").textContent).toContain(
      "Cancelling pairing",
    );
    expect(screen.queryByRole("button", { name: "Codes match" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  } finally {
    status = { phase: "error", message: "Pairing was canceled." };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(screen.getByRole("alert").textContent).toContain(
      "Pairing was canceled.",
    );
  }
});
