// Injected by host.spec.mjs into the native window before the app's own
// scripts. Seeds the fixture account once, then runs commands from run.mjs:
// open the thread, load its full history, and record frames during flings.
// Keeps measurement code out of src/.
(() => {
  // Errors before the command loop starts would otherwise be invisible.
  const beacon = (text) => {
    new Image().src = `/__perf/log?${encodeURIComponent(String(text).slice(0, 500))}`;
  };
  addEventListener("error", (event) => beacon(`error ${event.message}`));
  addEventListener("unhandledrejection", (event) =>
    beacon(`rejection ${event.reason?.message ?? event.reason}`),
  );
  beacon("agent start");
  const SEEDED = "buzz.perf-native.seeded";
  const xhr = new XMLHttpRequest();
  xhr.open("GET", "/__perf/workload", false);
  xhr.send();
  const workload = JSON.parse(xhr.responseText);
  // Reloads within one host run keep their state; a new host run (new fixture
  // keys) always starts from its own seed.
  if (localStorage.getItem(SEEDED) !== workload.seedId) {
    localStorage.clear();
    for (const [key, value] of Object.entries(workload.seed))
      localStorage.setItem(key, value);
    localStorage.setItem("buzz-mac-welcome-intro.v1", "1");
    localStorage.setItem(SEEDED, workload.seedId);
  }
  // As the browser fixture does: no launch overlay over the measured surface.
  const launch = new MutationObserver(() => {
    const element = document.getElementById("buzz-launch");
    if (!element) return;
    element.remove();
    for (const id of ["root", "buzz-toast-root"]) {
      document.getElementById(id)?.removeAttribute("inert");
      document.getElementById(id)?.removeAttribute("aria-hidden");
    }
    launch.disconnect();
  });
  launch.observe(document, { childList: true, subtree: true });

  const thread = () => document.querySelector('[aria-label="Thread messages"]');
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const workloadNow = async () => (await fetch("/__perf/workload")).json();

  function geometry(element) {
    if (!element) return null;
    const box = element.getBoundingClientRect();
    return {
      rect: [box.left, box.top, box.width, box.height],
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
      mounted: element.querySelectorAll("[data-message-id]").length,
      topLevel: element.querySelectorAll(
        ":scope > [data-thread-rows] > ol > li[data-layout]",
      ).length,
      positioning: element.hasAttribute("data-positioning"),
    };
  }
  const status = () => ({
    arm: workload.arm,
    origin: performance.timeOrigin,
    thread: geometry(thread()),
    window: [screenX, screenY, innerWidth, innerHeight],
    dpr: devicePixelRatio,
    native: !!window.__TAURI_INTERNALS__,
    keyboardNavigation: document.documentElement.hasAttribute(
      "data-keyboard-navigation",
    ),
  });

  async function until(check, timeoutMs, message) {
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      const value = check();
      if (value) return value;
      if (performance.now() > deadline) throw new Error(message);
      await pause(100);
    }
  }

  async function open() {
    const channel = await until(
      () =>
        document.querySelector(
          `button[data-channel-id="${workload.channelId}"]`,
        ),
      30_000,
      "thread channel never appeared",
    );
    channel.click();
    const row = await until(
      () =>
        document.querySelector(
          `section[data-channel-timeline="${workload.channelId}"] [data-message-id="${workload.rootId}"]`,
        ),
      30_000,
      "thread root never appeared",
    );
    // Message actions mount on first pointer entry.
    row.dispatchEvent(new PointerEvent("pointerenter"));
    const reply = await until(
      () =>
        [...row.querySelectorAll("button")].find((button) =>
          /^(Reply|View thread)/.test(
            button.getAttribute("aria-label") ?? button.textContent ?? "",
          ),
        ),
      10_000,
      "thread root has no reply control",
    );
    reply.click();
    await until(
      () => thread() && !thread().hasAttribute("data-positioning"),
      30_000,
      "thread never finished positioning",
    );
    return status();
  }

  // Load every older page the thread holds. Upward wheel input records the
  // panel's older-page demand; the host releases each page immediately.
  async function preload({ timeoutMs = 120_000 } = {}) {
    const element = thread();
    if (!element) throw new Error("thread is not open");
    const deadline = performance.now() + timeoutMs;
    let previous = -1;
    let stable = 0;
    while (stable < 15) {
      if (performance.now() > deadline)
        throw new Error("thread history did not finish loading");
      element.scrollTop = 0;
      element.dispatchEvent(
        new WheelEvent("wheel", { deltaY: -120, bubbles: true }),
      );
      await pause(200);
      const count = element.querySelectorAll(
        ":scope > [data-thread-rows] > ol > li[data-layout]",
      ).length;
      stable = count === previous ? stable + 1 : 0;
      previous = count;
    }
    element.scrollTop = element.scrollHeight;
    await pause(100);
    const { topLevel } = await workloadNow();
    return { ...status(), expectedTopLevel: topLevel };
  }

  // Per frame: time, scroll offset and extent. Painted pixels come from the
  // video, not the DOM.
  let recording;
  function sample(now) {
    if (!recording) return;
    const element = thread();
    if (element)
      recording.frames.push([
        now - recording.start,
        element.scrollTop,
        element.scrollHeight,
        element.clientHeight,
      ]);
    recording.raf = requestAnimationFrame(sample);
  }
  function record({ label }) {
    stop();
    const start = performance.now();
    const wheels = [];
    const onWheel = (event) =>
      wheels.push([event.timeStamp - start, event.deltaY]);
    addEventListener("wheel", onWheel, { capture: true, passive: true });
    recording = {
      label,
      start,
      frames: [],
      wheels,
      onWheel,
      raf: requestAnimationFrame(sample),
    };
    return { recording: label };
  }
  function stop() {
    const done = recording;
    if (!done) return null;
    recording = undefined;
    cancelAnimationFrame(done.raf);
    removeEventListener("wheel", done.onWheel, { capture: true });
    return {
      label: done.label,
      frames: done.frames,
      wheels: done.wheels,
      end: status(),
    };
  }
  function jump() {
    const element = thread();
    const button = element?.querySelector("[data-jump-to-latest]");
    if (button?.closest("[data-visible]")?.dataset.visible === "true")
      button.click();
    else if (element) element.scrollTop = element.scrollHeight;
    return { jumped: true };
  }
  function bottom() {
    const element = thread();
    if (element) element.scrollTop = element.scrollHeight;
    return status();
  }
  // The macOS window starts hidden until the app's launch script shows it;
  // show it explicitly, through the same window command, before measuring.
  // and place it like the reference measurements: a 579px thread pane.
  async function show({ x = 18, y = 51, width = 1504, height = 916 } = {}) {
    const native = window.__TAURI_INTERNALS__;
    if (!native) throw new Error("not running in the desktop app");
    await native.invoke("plugin:window|set_size", {
      label: "main",
      value: { Logical: { width, height } },
    });
    await native.invoke("plugin:window|set_position", {
      label: "main",
      value: { Logical: { x, y } },
    });
    await native.invoke("plugin:window|show", { label: "main" });
    await native.invoke("plugin:window|set_focus", { label: "main" });
    // Animation frames do not run while the window is hidden; wait on a timer.
    await pause(300);
    return status();
  }
  const handlers = {
    status,
    show,
    open,
    preload,
    record,
    stop,
    jump,
    bottom,
    reload: () => {
      setTimeout(() => location.reload(), 50);
      return { reloading: true };
    },
  };

  async function loop() {
    for (;;) {
      let command;
      try {
        const response = await fetch("/__perf/next", { method: "POST" });
        if (response.status !== 200) continue;
        command = await response.json();
      } catch {
        await pause(1000);
        continue;
      }
      let result;
      try {
        result = { ok: true, value: await handlers[command.type](command) };
      } catch (error) {
        result = { ok: false, error: String(error?.message ?? error) };
      }
      await fetch("/__perf/result", {
        method: "POST",
        body: JSON.stringify({ id: command.id, ...result }),
      });
    }
  }
  addEventListener("load", () => void loop(), { once: true });
})();
