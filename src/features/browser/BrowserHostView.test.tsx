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
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PanelWorkspace } from "../panels/PanelWorkspace";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { GaugeIcon } from "../../shared/design-system/icons";
import { BrowserHostView } from "./BrowserHostView";
import { BrowserAttachError, type BrowserPlatform } from "./platform";
import { BrowserSessions } from "./sessions";

class TestResizeObserver {
  static callbacks: Array<() => void> = [];
  constructor(callback: () => void) {
    TestResizeObserver.callbacks.push(callback);
  }
  observe() {}
  disconnect() {}
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function fakePlatform(): BrowserPlatform {
  return {
    available: true,
    attach: vi.fn(async () => "session-1"),
    setBounds: vi.fn(async () => {}),
    setMediaSuspended: vi.fn(async () => {}),
    navigate: vi.fn(async () => {}),
    action: vi.fn(async () => {}),
    status: vi.fn(async () => ({
      url: "https://example.com/",
      title: "Example",
      loading: false,
      error: null,
    })),
    detach: vi.fn(async () => {}),
    openExternal: vi.fn(async () => {}),
  };
}

beforeEach(() => {
  TestResizeObserver.callbacks = [];
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 10,
    y: 20,
    left: 10,
    top: 20,
    right: 410,
    bottom: 320,
    width: 400,
    height: 300,
    toJSON: () => ({}),
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("attaches hidden-first guest bounds and detaches on close", async () => {
  const platform = fakePlatform();
  const view = render(
    <BrowserHostView
      url="https://example.com"
      platform={platform}
      sessions={new BrowserSessions(platform)}
    />,
  );
  await waitFor(() =>
    expect(platform.setBounds).toHaveBeenCalledWith(
      "session-1",
      { x: 10, y: 20, width: 400, height: 300 },
      true,
    ),
  );
  const viewport = view.container.querySelector(
    '[data-browser-session="session-1"]',
  );
  expect(viewport).not.toBeNull();
  view.unmount();
  expect(viewport).not.toHaveAttribute("data-browser-session");
  await waitFor(() =>
    expect(platform.detach).toHaveBeenCalledWith("session-1"),
  );
});

it("detaches a late attach result and serializes its replacement", async () => {
  const first = deferred<string>();
  const platform = fakePlatform();
  vi.mocked(platform.attach)
    .mockImplementationOnce(() => first.promise)
    .mockResolvedValueOnce("session-2");
  const sessions = new BrowserSessions(platform);
  const view = render(
    <BrowserHostView
      url="https://one.example"
      platform={platform}
      sessions={sessions}
    />,
  );
  await waitFor(() => expect(platform.attach).toHaveBeenCalledTimes(1));
  view.rerender(
    <BrowserHostView
      url="https://two.example"
      platform={platform}
      sessions={sessions}
    />,
  );
  expect(platform.attach).toHaveBeenCalledTimes(1);
  first.resolve("session-1");
  await waitFor(() =>
    expect(platform.detach).toHaveBeenCalledWith("session-1"),
  );
  await waitFor(() => expect(platform.attach).toHaveBeenCalledTimes(2));
  await waitFor(() =>
    expect(
      view.container.querySelector('[data-browser-session="session-2"]'),
    ).not.toBeNull(),
  );
  expect(
    vi.mocked(platform.detach).mock.invocationCallOrder[0] ?? 0,
  ).toBeLessThan(vi.mocked(platform.attach).mock.invocationCallOrder[1] ?? 0);
  view.unmount();
});

it("forces a bounds update on window resize even when geometry is unchanged", async () => {
  const platform = fakePlatform();
  render(
    <BrowserHostView
      url="https://example.com"
      platform={platform}
      sessions={new BrowserSessions(platform)}
    />,
  );
  await waitFor(() => expect(platform.setBounds).toHaveBeenCalledTimes(1));
  fireEvent(window, new Event("resize"));
  await waitFor(() => expect(platform.setBounds).toHaveBeenCalledTimes(2));
});

it("hides with the last valid bounds when the viewport leaves the window", async () => {
  const platform = fakePlatform();
  render(
    <BrowserHostView
      url="https://example.com"
      platform={platform}
      sessions={new BrowserSessions(platform)}
    />,
  );
  await waitFor(() => expect(platform.setBounds).toHaveBeenCalledTimes(1));
  vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue({
    x: 1200,
    y: 20,
    left: 1200,
    top: 20,
    right: 1600,
    bottom: 320,
    width: 400,
    height: 300,
    toJSON: () => ({}),
  });
  fireEvent.scroll(window);
  await waitFor(() => expect(platform.setBounds).toHaveBeenCalledTimes(2));
  expect(platform.setBounds).toHaveBeenLastCalledWith(
    "session-1",
    { x: 10, y: 20, width: 400, height: 300 },
    false,
  );
});

it("waits for positive viewport bounds before attaching", async () => {
  const platform = fakePlatform();
  vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValueOnce({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
    width: 0,
    height: 0,
    toJSON: () => ({}),
  });
  render(
    <BrowserHostView
      url="https://example.com"
      platform={platform}
      sessions={new BrowserSessions(platform)}
    />,
  );
  expect(platform.attach).not.toHaveBeenCalled();
  TestResizeObserver.callbacks[0]?.();
  await waitFor(() => expect(platform.attach).toHaveBeenCalledTimes(1));
});

it("hides when an already-open modal is inserted and shows after removal", async () => {
  const platform = fakePlatform();
  render(
    <BrowserHostView
      url="https://example.com"
      platform={platform}
      sessions={new BrowserSessions(platform)}
    />,
  );
  await waitFor(() => expect(platform.setBounds).toHaveBeenCalledTimes(1));
  const dialog = document.createElement("dialog");
  dialog.setAttribute("open", "");
  document.body.append(dialog);
  await waitFor(() =>
    expect(platform.setBounds).toHaveBeenLastCalledWith(
      "session-1",
      expect.any(Object),
      false,
    ),
  );
  dialog.remove();
  await waitFor(() =>
    expect(platform.setBounds).toHaveBeenLastCalledWith(
      "session-1",
      expect.any(Object),
      true,
    ),
  );
});

it("hides for host popups marked after the browser is attached", async () => {
  const platform = fakePlatform();
  render(
    <BrowserHostView
      url="https://example.com"
      platform={platform}
      sessions={new BrowserSessions(platform)}
    />,
  );
  await waitFor(() => expect(platform.setBounds).toHaveBeenCalledTimes(1));
  const popup = document.createElement("nav");
  popup.setAttribute("data-side", "bottom");
  document.body.append(popup);
  popup.setAttribute("data-open", "");
  await waitFor(() =>
    expect(platform.setBounds).toHaveBeenLastCalledWith(
      "session-1",
      expect.any(Object),
      false,
    ),
  );
  popup.removeAttribute("data-open");
  await waitFor(() =>
    expect(platform.setBounds).toHaveBeenLastCalledWith(
      "session-1",
      expect.any(Object),
      true,
    ),
  );
  popup.remove();
});

it("hides while its tab is covered and shows when it is selected again", async () => {
  const platform = fakePlatform();
  const view = render(
    <div data-testid="pane">
      <BrowserHostView
        url="https://example.com"
        platform={platform}
        sessions={new BrowserSessions(platform)}
      />
    </div>,
  );
  await waitFor(() => expect(platform.setBounds).toHaveBeenCalledTimes(1));
  const pane = view.getByTestId("pane");
  pane.setAttribute("data-covered", "");
  pane.setAttribute("inert", "");
  await waitFor(() =>
    expect(platform.setBounds).toHaveBeenLastCalledWith(
      "session-1",
      expect.any(Object),
      false,
    ),
  );
  pane.removeAttribute("data-covered");
  pane.removeAttribute("inert");
  await waitFor(() =>
    expect(platform.setBounds).toHaveBeenLastCalledWith(
      "session-1",
      expect.any(Object),
      true,
    ),
  );
  expect(platform.attach).toHaveBeenCalledTimes(1);
});

it("does not attach until its sliding pane has landed", async () => {
  const platform = fakePlatform();
  const view = render(
    <div data-testid="pane" data-entering="">
      <BrowserHostView
        url="https://example.com"
        platform={platform}
        sessions={new BrowserSessions(platform)}
      />
    </div>,
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(platform.attach).not.toHaveBeenCalled();
  view.getByTestId("pane").removeAttribute("data-entering");
  await waitFor(() => expect(platform.attach).toHaveBeenCalledTimes(1));
});

it("keeps each view's guest while another view is shown", async () => {
  const platform = fakePlatform();
  let next = 0;
  vi.mocked(platform.attach).mockImplementation(
    async () => `session-${++next}`,
  );
  const sessions = new BrowserSessions(platform);
  const view = render(
    <>
      <div data-testid="first">
        <BrowserHostView
          url="https://first.example/"
          platform={platform}
          sessions={sessions}
        />
      </div>
      <div data-testid="second" data-covered="">
        <BrowserHostView
          url="https://second.example/"
          platform={platform}
          sessions={sessions}
        />
      </div>
    </>,
  );
  await waitFor(() => expect(platform.attach).toHaveBeenCalledTimes(1));
  const first = view.getByTestId("first");
  const second = view.getByTestId("second");
  first.setAttribute("data-covered", "");
  second.removeAttribute("data-covered");
  await waitFor(() => expect(platform.attach).toHaveBeenCalledTimes(2));
  vi.mocked(platform.setBounds).mockClear();
  second.setAttribute("data-covered", "");
  first.removeAttribute("data-covered");
  await waitFor(() =>
    expect(platform.setBounds).toHaveBeenCalledWith(
      "session-1",
      expect.any(Object),
      true,
    ),
  );
  expect(platform.attach).toHaveBeenCalledTimes(2);
  expect(platform.detach).not.toHaveBeenCalled();
});

it("retries a failed evicted guest at its last page only on explicit Reload", async () => {
  const platform = fakePlatform();
  let next = 0;
  const retry = deferred<string>();
  vi.mocked(platform.attach).mockImplementation(async () => {
    next++;
    if (next === 6) throw new Error("Native browser unavailable");
    if (next === 7) return retry.promise;
    return `session-${next}`;
  });
  vi.mocked(platform.status).mockImplementation(async (sessionId) => ({
    url: sessionId === "session-1" ? "https://first.example/signed-in" : "",
    title: "",
    loading: false,
    error: null,
  }));
  const sessions = new BrowserSessions(platform);
  const urls = [1, 2, 3, 4, 5].map((n) => `https://view${n}.example/`);
  const view = render(
    <>
      {urls.map((url, index) => (
        <div key={url} data-testid={`pane-${index}`} data-covered="">
          <BrowserHostView
            url={url}
            platform={platform}
            sessions={sessions}
            pollInterval={5}
          />
        </div>
      ))}
    </>,
  );
  const show = async (index: number) => {
    for (const [other] of urls.entries())
      view.getByTestId(`pane-${other}`).setAttribute("data-covered", "");
    view.getByTestId(`pane-${index}`).removeAttribute("data-covered");
  };
  await show(0);
  await waitFor(() =>
    expect(platform.status).toHaveBeenCalledWith("session-1"),
  );
  for (const index of [1, 2, 3, 4]) {
    await show(index);
    await waitFor(() =>
      expect(platform.attach).toHaveBeenCalledTimes(index + 1),
    );
  }
  expect(platform.detach).toHaveBeenCalledWith("session-1");
  await show(0);
  await waitFor(() =>
    expect(platform.attach).toHaveBeenLastCalledWith(
      "https://first.example/signed-in",
      expect.any(Object),
      undefined,
      undefined,
    ),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Native browser unavailable",
  );
  const user = userEvent.setup();
  const reload = within(view.getByTestId("pane-0")).getByRole("button", {
    name: "Reload",
  });
  await act(async () => TestResizeObserver.callbacks[0]?.());
  expect(platform.attach).toHaveBeenCalledTimes(6);
  // An explicit retry keeps toolbar focus, and repeated Reload while it is
  // pending must not queue another native guest.
  await user.click(reload);
  try {
    await waitFor(() => expect(platform.attach).toHaveBeenCalledTimes(7));
    expect(reload).toHaveFocus();
    await user.click(reload);
    expect(platform.attach).toHaveBeenCalledTimes(7);
  } finally {
    retry.resolve("session-7");
  }
  await waitFor(() =>
    expect(platform.setBounds).toHaveBeenCalledWith(
      "session-7",
      expect.any(Object),
      true,
    ),
  );
  expect(platform.attach).toHaveBeenLastCalledWith(
    "https://first.example/signed-in",
    expect.any(Object),
    undefined,
    undefined,
  );
  expect(screen.queryByRole("alert")).toBeNull();
  expect(reload).toHaveFocus();
});

it("parks a kept-storage guest on unmount and adopts it when remounted", async () => {
  const platform = fakePlatform();
  const sessions = new BrowserSessions(platform);
  const mount = () =>
    render(
      <BrowserHostView
        url="https://app.example/"
        storage="builderlab-apps"
        platform={platform}
        sessions={sessions}
      />,
    );
  const first = mount();
  await waitFor(() => expect(platform.setBounds).toHaveBeenCalled());
  first.unmount();
  await waitFor(() =>
    expect(platform.setBounds).toHaveBeenLastCalledWith(
      "session-1",
      expect.any(Object),
      false,
    ),
  );
  mount();
  await waitFor(() =>
    expect(platform.setBounds).toHaveBeenLastCalledWith(
      "session-1",
      expect.any(Object),
      true,
    ),
  );
  expect(platform.attach).toHaveBeenCalledTimes(1);
  expect(platform.detach).not.toHaveBeenCalled();
});

it("stays shown for a popup that does not reach over it", async () => {
  const platform = fakePlatform();
  render(
    <BrowserHostView
      url="https://example.com"
      platform={platform}
      sessions={new BrowserSessions(platform)}
    />,
  );
  await waitFor(() => expect(platform.setBounds).toHaveBeenCalledTimes(1));
  const tooltip = document.createElement("div");
  tooltip.setAttribute("data-side", "top");
  tooltip.getBoundingClientRect = () =>
    ({
      left: 500,
      right: 560,
      top: 20,
      bottom: 40,
      width: 60,
      height: 20,
    }) as DOMRect;
  // As Base UI marks a hovered message action and its tooltip.
  const trigger = document.createElement("button");
  document.body.append(trigger, tooltip);
  trigger.setAttribute("data-popup-open", "");
  tooltip.setAttribute("data-open", "");
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(platform.setBounds).not.toHaveBeenCalledWith(
    "session-1",
    expect.any(Object),
    false,
  );
  trigger.remove();
  tooltip.remove();
});

it("keeps the website visible while a composer control's hover hint overlaps it", async () => {
  const platform = fakePlatform();
  const user = userEvent.setup();
  render(
    <>
      <IconButton
        aria-label="Model and effort"
        title="Model and effort for the next run"
        icon={<GaugeIcon />}
      />
      <BrowserHostView
        url="https://example.com"
        platform={platform}
        sessions={new BrowserSessions(platform)}
      />
    </>,
  );
  await waitFor(() => expect(platform.setBounds).toHaveBeenCalledTimes(1));
  const updateBrowser = TestResizeObserver.callbacks[0];
  await user.hover(screen.getByRole("button", { name: "Model and effort" }));
  expect(await screen.findByRole("tooltip")).toHaveTextContent(
    "Model and effort for the next run",
  );
  // Force a completed presentation pass with the hint mounted. The layout
  // fixture places it over the native viewport, as at the edge of a pane.
  act(() => updateBrowser?.());
  expect(platform.setBounds).toHaveBeenLastCalledWith(
    "session-1",
    expect.any(Object),
    true,
  );
  expect(platform.attach).toHaveBeenCalledTimes(1);
  expect(platform.detach).not.toHaveBeenCalled();
});

it("names its tab from the label until the page has a title", async () => {
  const platform = fakePlatform();
  vi.mocked(platform.status).mockResolvedValue({
    url: "https://example.com/",
    title: "",
    loading: false,
    error: null,
  });
  render(
    <PanelWorkspace
      value="tab"
      select={() => {}}
      items={[
        {
          id: "tab",
          label: "App",
          content: (
            <BrowserHostView
              url="https://example.com"
              label="demo"
              platform={platform}
              sessions={new BrowserSessions(platform)}
              pollInterval={5}
            />
          ),
        },
      ]}
    />,
  );
  expect(screen.getByRole("tab")).toHaveTextContent("demo");
  vi.mocked(platform.status).mockResolvedValue({
    url: "https://example.com/",
    title: "Demo app",
    loading: false,
    error: null,
  });
  await waitFor(() =>
    expect(screen.getByRole("tab")).toHaveTextContent("Demo app"),
  );
});

it("keeps the page's last title while it reports none or opens again", async () => {
  const platform = fakePlatform();
  const sessions = new BrowserSessions(platform);
  vi.mocked(platform.status).mockResolvedValue({
    url: "https://example.com/",
    title: "Demo app",
    loading: false,
    error: null,
  });
  const workspace = () => (
    <PanelWorkspace
      value="tab"
      select={() => {}}
      items={[
        {
          id: "tab",
          label: "App",
          content: (
            <BrowserHostView
              url="https://example.com"
              label="demo"
              platform={platform}
              sessions={sessions}
              pollInterval={5}
            />
          ),
        },
      ]}
    />
  );
  const first = render(workspace());
  await waitFor(() =>
    expect(screen.getByRole("tab")).toHaveTextContent("Demo app"),
  );
  vi.mocked(platform.status).mockResolvedValue({
    url: "https://example.com/",
    title: "",
    loading: true,
    error: null,
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(screen.getByRole("tab")).toHaveTextContent("Demo app");
  first.unmount();
  render(workspace());
  expect(screen.getByRole("tab")).toHaveTextContent("Demo app");
});

it("serializes presentation writes and applies the newest visibility", async () => {
  const firstWrite = deferred<void>();
  const platform = fakePlatform();
  vi.mocked(platform.setBounds)
    .mockImplementationOnce(() => firstWrite.promise)
    .mockResolvedValue(undefined);
  render(
    <BrowserHostView
      url="https://example.com"
      platform={platform}
      sessions={new BrowserSessions(platform)}
    />,
  );
  await waitFor(() => expect(platform.setBounds).toHaveBeenCalledTimes(1));
  const dialog = document.createElement("dialog");
  dialog.setAttribute("open", "");
  document.body.append(dialog);
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  expect(platform.setBounds).toHaveBeenCalledTimes(1);
  firstWrite.resolve();
  await waitFor(() => expect(platform.setBounds).toHaveBeenCalledTimes(2));
  expect(platform.setBounds).toHaveBeenLastCalledWith(
    "session-1",
    expect.any(Object),
    false,
  );
  dialog.remove();
});

it("renders attach failures in toolbar space outside native guest bounds", async () => {
  const platform = fakePlatform();
  vi.mocked(platform.attach).mockRejectedValue(
    new Error("Native browser unavailable"),
  );
  render(
    <BrowserHostView
      url="https://example.com"
      platform={platform}
      sessions={new BrowserSessions(platform)}
    />,
  );
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("Native browser unavailable");
  expect(alert.parentElement).toHaveAttribute("aria-label", "Browser");
});

it("shows a refused app as a page in the website's place, with no reason", async () => {
  const platform = fakePlatform();
  const user = userEvent.setup();
  vi.mocked(platform.attach)
    .mockRejectedValueOnce(
      new BrowserAttachError(
        "Your Builderlab account cannot open this app",
        "denied",
      ),
    )
    .mockResolvedValueOnce("session-1");
  render(
    <BrowserHostView
      url="https://example.com"
      platform={platform}
      sessions={new BrowserSessions(platform)}
      pollInterval={50_000}
    />,
  );
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("You can’t open this app");
  expect(alert).toHaveTextContent(
    "The link may be wrong, or the app may have been removed. Ask whoever shared it.",
  );
  expect(alert).not.toHaveTextContent("Builderlab account");
  expect(screen.getAllByRole("alert")).toHaveLength(1);
  // In the website viewport, not the error bar's toolbar space.
  expect(alert.parentElement).not.toHaveAttribute("aria-label", "Browser");

  await user.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() =>
    expect(platform.status).toHaveBeenCalledWith("session-1"),
  );
  expect(platform.attach).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("offers Try again and the system browser when Builderlab can't be reached", async () => {
  const platform = fakePlatform();
  const user = userEvent.setup();
  vi.mocked(platform.attach)
    .mockRejectedValueOnce(
      new BrowserAttachError(
        "Builderlab sign-in request failed",
        "unavailable",
      ),
    )
    .mockResolvedValueOnce("session-1");
  vi.mocked(platform.openExternal)
    .mockRejectedValueOnce(new Error("no browser"))
    .mockResolvedValueOnce(undefined);
  render(
    <BrowserHostView
      url="https://example.com/app"
      platform={platform}
      sessions={new BrowserSessions(platform)}
      pollInterval={50_000}
    />,
  );
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("Buzz couldn’t load this app");
  expect(alert).not.toHaveTextContent("sign-in request failed");
  expect(screen.getAllByRole("alert")).toHaveLength(1);

  await user.click(screen.getByRole("button", { name: "Open in browser" }));
  expect(platform.openExternal).toHaveBeenCalledWith("https://example.com/app");
  expect(
    await screen.findByText(
      "Couldn’t open it in your browser. Try again in a moment.",
    ),
  ).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Open in browser" }));
  await waitFor(() =>
    expect(
      screen.queryByText(
        "Couldn’t open it in your browser. Try again in a moment.",
      ),
    ).not.toBeInTheDocument(),
  );
  expect(platform.attach).toHaveBeenCalledTimes(1);

  await user.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() =>
    expect(platform.status).toHaveBeenCalledWith("session-1"),
  );
  expect(platform.attach).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("keeps Try again focused while a refused app retries", async () => {
  const platform = fakePlatform();
  const user = userEvent.setup();
  const refused = () =>
    new BrowserAttachError(
      "Your Builderlab account cannot open this app",
      "denied",
    );
  let settle: { resolve(id: string): void; reject(error: unknown): void } = {
    resolve: () => {},
    reject: () => {},
  };
  const deferred = () =>
    new Promise<string>((resolve, reject) => {
      settle = { resolve, reject };
    });
  vi.mocked(platform.attach)
    .mockRejectedValueOnce(refused())
    .mockImplementationOnce(deferred)
    .mockRejectedValueOnce(refused())
    .mockImplementationOnce(deferred);
  render(
    <BrowserHostView
      url="https://example.com"
      platform={platform}
      sessions={new BrowserSessions(platform)}
      pollInterval={50_000}
    />,
  );
  const retry = await screen.findByRole("button", { name: "Try again" });
  retry.focus();

  // Pending: the page and its focused button stay, and a repeat does nothing.
  await user.keyboard("{Enter}");
  await waitFor(() => expect(platform.attach).toHaveBeenCalledTimes(2));
  expect(retry).toHaveFocus();
  expect(retry).toHaveAttribute("aria-busy", "true");
  await user.keyboard("{Enter}");
  expect(platform.attach).toHaveBeenCalledTimes(2);

  // Refused again: still the same focused button, ready to retry.
  await act(async () => settle.reject(refused()));
  expect(retry).toBeInTheDocument();
  expect(retry).toHaveFocus();
  expect(retry).not.toHaveAttribute("aria-busy");

  // An immediate repeated refusal keeps focus too.
  await user.keyboard("{Enter}");
  await waitFor(() => expect(platform.attach).toHaveBeenCalledTimes(3));
  await waitFor(() => expect(retry).not.toHaveAttribute("aria-busy"));
  expect(retry).toHaveFocus();

  // Success replaces the page with the website.
  await user.keyboard("{Enter}");
  await waitFor(() => expect(platform.attach).toHaveBeenCalledTimes(4));
  expect(retry).toHaveFocus();
  await act(async () => settle.resolve("session-1"));
  await waitFor(() =>
    expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
  );
});

it("keeps Try again focused while an unreachable Builderlab retries", async () => {
  const platform = fakePlatform();
  const user = userEvent.setup();
  const unreachable = () =>
    new BrowserAttachError("Builderlab sign-in request failed", "unavailable");
  let settle: { resolve(id: string): void; reject(error: unknown): void } = {
    resolve: () => {},
    reject: () => {},
  };
  const deferred = () =>
    new Promise<string>((resolve, reject) => {
      settle = { resolve, reject };
    });
  vi.mocked(platform.attach)
    .mockRejectedValueOnce(unreachable())
    .mockImplementationOnce(deferred)
    .mockImplementationOnce(deferred);
  render(
    <BrowserHostView
      url="https://example.com"
      platform={platform}
      sessions={new BrowserSessions(platform)}
      pollInterval={50_000}
    />,
  );
  const retry = await screen.findByRole("button", { name: "Try again" });
  retry.focus();

  await user.keyboard("{Enter}");
  await waitFor(() => expect(platform.attach).toHaveBeenCalledTimes(2));
  expect(retry).toHaveFocus();
  expect(retry).toHaveAttribute("aria-busy", "true");
  expect(
    screen.getByRole("button", { name: "Open in browser" }),
  ).toBeInTheDocument();
  await user.keyboard("{Enter}");
  expect(platform.attach).toHaveBeenCalledTimes(2);

  await act(async () => settle.reject(unreachable()));
  expect(retry).toHaveFocus();
  expect(retry).not.toHaveAttribute("aria-busy");

  await user.keyboard("{Enter}");
  await waitFor(() => expect(platform.attach).toHaveBeenCalledTimes(3));
  await act(async () => settle.resolve("session-1"));
  await waitFor(() =>
    expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
  );
});

it("moves focus to the error when a retry from the page fails another way", async () => {
  const platform = fakePlatform();
  const user = userEvent.setup();
  const refused = () =>
    new BrowserAttachError(
      "Your Builderlab account cannot open this app",
      "denied",
    );
  let fail: (error: unknown) => void = () => {};
  const deferred = () =>
    new Promise<string>((_, reject) => {
      fail = reject;
    });
  vi.mocked(platform.attach)
    .mockRejectedValueOnce(refused())
    .mockImplementationOnce(deferred)
    .mockRejectedValueOnce(refused())
    .mockImplementationOnce(deferred);
  render(
    <BrowserHostView
      url="https://example.com"
      platform={platform}
      sessions={new BrowserSessions(platform)}
      pollInterval={50_000}
    />,
  );
  const retry = await screen.findByRole("button", { name: "Try again" });
  retry.focus();
  await user.keyboard("{Enter}");
  await waitFor(() => expect(platform.attach).toHaveBeenCalledTimes(2));
  await act(async () =>
    fail(new BrowserAttachError("Builderlab sign-in request failed")),
  );
  const alert = screen.getByRole("alert");
  expect(alert).toHaveTextContent("Builderlab sign-in request failed");
  expect(alert).toHaveFocus();

  // Focus the user has moved elsewhere in the meantime stays where it is.
  await user.click(screen.getByRole("button", { name: "Reload" }));
  const again = await screen.findByRole("button", { name: "Try again" });
  again.focus();
  await user.keyboard("{Enter}");
  await waitFor(() => expect(platform.attach).toHaveBeenCalledTimes(4));
  const address = screen.getByRole("textbox");
  address.focus();
  await act(async () =>
    fail(new BrowserAttachError("Builderlab sign-in request failed")),
  );
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Builderlab sign-in request failed",
  );
  expect(address).toHaveFocus();
});

it("keeps other attach failures in the error bar", async () => {
  const platform = fakePlatform();
  vi.mocked(platform.attach).mockRejectedValue(
    new BrowserAttachError("Builderlab sign-in request failed"),
  );
  render(
    <BrowserHostView
      url="https://example.com"
      platform={platform}
      sessions={new BrowserSessions(platform)}
    />,
  );
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("Builderlab sign-in request failed");
  expect(alert.parentElement).toHaveAttribute("aria-label", "Browser");
  expect(
    screen.queryByRole("button", { name: "Try again" }),
  ).not.toBeInTheDocument();
});

it("routes address and navigation controls to the active session", async () => {
  const platform = fakePlatform();
  const user = userEvent.setup();
  render(
    <BrowserHostView
      url="https://example.com"
      platform={platform}
      sessions={new BrowserSessions(platform)}
      pollInterval={50_000}
    />,
  );
  await waitFor(() =>
    expect(platform.status).toHaveBeenCalledWith("session-1"),
  );
  const address = screen.getByLabelText("Address");
  await user.clear(address);
  await user.type(address, "https://other.example{Enter}");
  await user.click(screen.getByLabelText("Back"));
  await user.click(screen.getByLabelText("Forward"));
  await user.click(screen.getByLabelText("Reload"));
  expect(platform.navigate).toHaveBeenCalledWith(
    "session-1",
    "https://other.example",
    false,
  );
  expect(platform.action).toHaveBeenCalledWith("session-1", "back");
  expect(platform.action).toHaveBeenCalledWith("session-1", "forward");
  expect(platform.action).toHaveBeenCalledWith("session-1", "reload");
});

it("keeps Reload keyboard-accessible while the website is loading", async () => {
  const platform = fakePlatform();
  vi.mocked(platform.status).mockResolvedValue({
    url: "https://example.com/",
    title: "Loading page",
    loading: true,
    error: null,
  });
  const user = userEvent.setup();
  render(
    <BrowserHostView
      url="https://example.com"
      platform={platform}
      sessions={new BrowserSessions(platform)}
      pollInterval={50_000}
    />,
  );
  await screen.findByTitle("Loading page");
  await user.tab();
  expect(screen.getByRole("button", { name: "Back" })).toHaveFocus();
  await user.tab();
  expect(screen.getByRole("button", { name: "Forward" })).toHaveFocus();
  await user.tab();
  expect(screen.getByRole("button", { name: "Reload" })).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(platform.action).toHaveBeenCalledWith("session-1", "reload");
});

it("navigates address input without a scheme over https, falling back to http", async () => {
  const platform = fakePlatform();
  const user = userEvent.setup();
  render(
    <BrowserHostView
      url="https://example.com"
      platform={platform}
      sessions={new BrowserSessions(platform)}
      pollInterval={50_000}
    />,
  );
  await waitFor(() =>
    expect(platform.status).toHaveBeenCalledWith("session-1"),
  );
  const address = screen.getByLabelText("Address");
  await user.clear(address);
  await user.type(address, "grugbrain.dev/{Enter}");
  expect(platform.navigate).toHaveBeenCalledWith(
    "session-1",
    "https://grugbrain.dev/",
    true,
  );
  await user.clear(address);
  await user.type(address, "https://example.org/{Enter}");
  expect(platform.navigate).toHaveBeenLastCalledWith(
    "session-1",
    "https://example.org/",
    false,
  );
});

it("shows a synchronous address validation error", async () => {
  const platform = fakePlatform();
  vi.mocked(platform.navigate).mockImplementation(() => {
    throw new Error("Only http and https URLs are supported");
  });
  const user = userEvent.setup();
  render(
    <BrowserHostView
      url="https://example.com"
      platform={platform}
      sessions={new BrowserSessions(platform)}
    />,
  );
  await waitFor(() => expect(platform.status).toHaveBeenCalled());
  const address = screen.getByLabelText("Address");
  await user.clear(address);
  await user.type(address, "file:///etc/passwd{Enter}");
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Only http and https URLs are supported",
  );
  vi.mocked(platform.navigate).mockRejectedValueOnce(
    new Error("Navigation denied"),
  );
  await user.clear(address);
  await user.type(address, "https://blocked.example{Enter}");
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent("Navigation denied"),
  );
});

it("shows a step to take elsewhere as a status, not an error", async () => {
  const platform = fakePlatform();
  vi.mocked(platform.status).mockResolvedValue({
    url: "https://example.com/",
    title: "",
    loading: false,
    error: null,
    notice: "Approve this app in your web browser, then select Reload",
  });
  render(
    <BrowserHostView
      url="https://example.com"
      platform={platform}
      sessions={new BrowserSessions(platform)}
      pollInterval={5}
    />,
  );
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Approve this app in your web browser, then select Reload",
  );
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("button", { name: "Open in browser" })).toBeNull();
});

it("opens a page the website asked for from its notice", async () => {
  const user = userEvent.setup();
  const platform = fakePlatform();
  vi.mocked(platform.status).mockResolvedValue({
    url: "https://example.com/",
    title: "",
    loading: false,
    error: null,
    notice: "This app wants to open a Builderlab page in your web browser",
    held: true,
  });
  render(
    <BrowserHostView
      url="https://example.com"
      platform={platform}
      sessions={new BrowserSessions(platform)}
      pollInterval={5}
    />,
  );
  await user.click(
    await screen.findByRole("button", { name: "Open in browser" }),
  );
  expect(platform.action).toHaveBeenCalledWith(expect.any(String), "open");
});

it("ignores status from a replaced session", async () => {
  const oldStatus = deferred<{
    url: string;
    title: string;
    loading: boolean;
    error: null;
  }>();
  const platform = fakePlatform();
  vi.mocked(platform.attach)
    .mockResolvedValueOnce("session-1")
    .mockResolvedValueOnce("session-2");
  vi.mocked(platform.status)
    .mockImplementationOnce(() => oldStatus.promise)
    .mockResolvedValueOnce({
      url: "https://new.example/",
      title: "New page",
      loading: false,
      error: null,
    });
  const sessions = new BrowserSessions(platform);
  const view = render(
    <BrowserHostView
      url="https://old.example"
      platform={platform}
      sessions={sessions}
      pollInterval={50_000}
    />,
  );
  await waitFor(() =>
    expect(platform.status).toHaveBeenCalledWith("session-1"),
  );
  view.rerender(
    <BrowserHostView
      url="https://new.example"
      platform={platform}
      sessions={sessions}
      pollInterval={50_000}
    />,
  );
  await waitFor(() =>
    expect(platform.status).toHaveBeenCalledWith("session-2"),
  );
  oldStatus.resolve({
    url: "https://old.example/",
    title: "Old page",
    loading: false,
    error: null,
  });
  await waitFor(() => expect(screen.getByTitle("New page")).toBeVisible());
  expect(screen.queryByText("Old page")).not.toBeInTheDocument();
});

it.each([false, true])(
  "restarts a lost Builderlab guest at the app URL instead of replaying its login ticket (resume policy: %s)",
  async (withPolicy) => {
    const platform = fakePlatform();
    let count = 0;
    vi.mocked(platform.attach).mockImplementation(
      async () => `guest-${++count}`,
    );
    const login =
      "https://login.apps.builderlab.xyz/api/goose/v1/auth/hosted-site/handoff?code=one-use";
    vi.mocked(platform.status).mockResolvedValue({
      url: login,
      title: "",
      loading: true,
      error: null,
    });
    const sessions = new BrowserSessions(platform);
    const lifetime = new AbortController();
    const builderlab = {
      federated: "private",
      storage: "viewer-test",
      signal: lifetime.signal,
    };
    const app = "https://counter.apps.builderlab.xyz/report/42";
    render(
      <BrowserHostView
        url={app}
        builderlab={builderlab}
        canResumeUrl={withPolicy ? () => false : undefined}
        platform={platform}
        sessions={sessions}
      />,
    );
    // Establish that polling applied the intermediate navigation before losing this guest.
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Address" })).toHaveValue(
        login,
      ),
    );
    await act(() => sessions.detach("guest-1"));
    fireEvent(window, new Event("resize"));
    await waitFor(() => expect(platform.attach).toHaveBeenCalledTimes(2));
    expect(platform.attach).toHaveBeenLastCalledWith(
      app,
      expect.any(Object),
      "viewer-test",
      builderlab,
    );
    lifetime.abort();
  },
);

it("restores the last approved app after eviction instead of a later consent ticket", async () => {
  const platform = fakePlatform();
  let count = 0;
  vi.mocked(platform.attach).mockImplementation(async () => `guest-${++count}`);
  const destination = "https://second.apps.example/report/42?q=week#chart";
  vi.mocked(platform.status).mockResolvedValue({
    url: destination,
    title: "Second app",
    loading: false,
    error: null,
  });
  const sessions = new BrowserSessions(platform);
  const lifetime = new AbortController();
  const builderlab = {
    federated: "private",
    storage: "viewer-test",
    signal: lifetime.signal,
  };
  const canResumeUrl = vi.fn((target: string) => target === destination);
  const view = render(
    <div data-testid="pane">
      <BrowserHostView
        url="https://first.apps.example/"
        builderlab={builderlab}
        canResumeUrl={canResumeUrl}
        platform={platform}
        sessions={sessions}
      />
    </div>,
  );
  await waitFor(() =>
    expect(screen.getByRole("textbox", { name: "Address" })).toHaveValue(
      destination,
    ),
  );
  const consent = "https://login.example/consent?ticket=one-use";
  vi.mocked(platform.status).mockResolvedValue({
    url: consent,
    title: "Consent",
    loading: true,
    error: null,
  });
  await waitFor(() =>
    expect(screen.getByRole("textbox", { name: "Address" })).toHaveValue(
      consent,
    ),
  );
  // Hide it, then fill the real four-guest pool so its oldest guest is evicted.
  view.getByTestId("pane").setAttribute("data-covered", "");
  await waitFor(() =>
    expect(platform.setBounds).toHaveBeenCalledWith(
      "guest-1",
      expect.any(Object),
      false,
    ),
  );
  await act(async () => {
    for (let index = 0; index < 4; index++)
      await sessions.attach(
        `https://ordinary${index}.example/`,
        {
          x: 0,
          y: 0,
          width: 400,
          height: 300,
        },
        () => true,
      );
  });
  expect(platform.detach).toHaveBeenCalledWith("guest-1");
  view.getByTestId("pane").removeAttribute("data-covered");
  await waitFor(() => expect(platform.attach).toHaveBeenCalledTimes(6));
  expect(platform.attach).toHaveBeenLastCalledWith(
    destination,
    expect.any(Object),
    "viewer-test",
    builderlab,
  );
  expect(canResumeUrl).toHaveBeenCalledWith(destination);
  expect(canResumeUrl).toHaveBeenCalledWith(consent);
  lifetime.abort();
});

it("takes mouse back/forward requests for its page from app navigation", async () => {
  const platform = fakePlatform();
  const view = render(
    <BrowserHostView
      url="https://example.com"
      platform={platform}
      sessions={new BrowserSessions(platform)}
      pollInterval={50_000}
    />,
  );
  await waitFor(() =>
    expect(platform.status).toHaveBeenCalledWith("session-1"),
  );
  const page = view.container.querySelector(
    '[data-browser-session="session-1"]',
  );
  if (!page) throw new Error("Browser page has no session");
  const app = vi.fn((event: Event) => event.defaultPrevented);
  window.addEventListener("buzz:history-back", app);
  window.addEventListener("buzz:history-forward", app);
  try {
    for (const name of ["buzz:history-back", "buzz:history-forward"]) {
      page.dispatchEvent(new Event(name, { cancelable: true, bubbles: true }));
    }
    await waitFor(() =>
      expect(platform.action).toHaveBeenCalledWith("session-1", "forward"),
    );
    expect(platform.action).toHaveBeenCalledWith("session-1", "back");
    expect(app.mock.results.map((result) => result.value)).toEqual([
      true,
      true,
    ]);
  } finally {
    window.removeEventListener("buzz:history-back", app);
    window.removeEventListener("buzz:history-forward", app);
  }
});
