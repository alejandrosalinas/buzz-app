import { readFileSync } from "node:fs";
import vm from "node:vm";
import { JSDOM } from "jsdom";
import { expect, it } from "vitest";

it("grants the widget read-only access to compute status", () => {
  const capability = JSON.parse(
    readFileSync(
      new URL("../src-tauri/capabilities/compute-widget.json", import.meta.url),
      "utf8",
    ),
  );
  expect(capability.permissions).toContain("allow-mesh-compute-widget-status");
  expect(capability.permissions).not.toContain("allow-mesh-compute-start");
  expect(capability.permissions).not.toContain("allow-mesh-compute-stop");
});

it("keeps four designs tied to fresh native usage and resets totals on replacement", async () => {
  const html = readFileSync(
    new URL("../compute-widget.html", import.meta.url),
    "utf8",
  );
  const script = readFileSync(
    new URL("../public/compute-widget.js", import.meta.url),
    "utf8",
  );
  const dom = new JSDOM(html, {
    runScripts: "outside-only",
    url: "http://localhost",
  });
  try {
    let status = {
      generation: 1,
      state: "running",
      usage: { tokensServed: 120, inflight: 0, tokensPerSecond: 5, peers: 2 },
    };
    const win = dom.window;
    win.matchMedia = () => ({ matches: true });
    win.HTMLCanvasElement.prototype.getContext = () =>
      new Proxy(
        {},
        {
          get: () => () => {},
        },
      );
    win.requestAnimationFrame = () => 0;
    win.setTimeout = () => 0;
    win.clearTimeout = () => {};
    let read = async () => status;
    const calls = [];
    win.__TAURI_INTERNALS__ = {
      invoke: (command, args) => {
        calls.push([command, args]);
        return read();
      },
    };
    const context = dom.getInternalVMContext();
    const run = (code) => vm.runInContext(code, context);
    run(script);
    await run("poll()");
    expect(run("model.total")).toBe(120);
    expect(run("model.phase")).toBe("online");
    for (let key = 0; key <= 9; key++) {
      win.dispatchEvent(new win.KeyboardEvent("keydown", { key: String(key) }));
      expect(run("inspectedState")).toBeNull();
    }
    // Animation previews require an explicit development URL.
    win.history.replaceState(null, "", "?preview=true");
    // Exercise the real moving bee, not only the reduced-motion fallback.
    const movingFrames = [0, 350, 700, 1100, 2200, 3800, 6500].map((elapsed) =>
      run(
        `draw("orbit", {phase:phases[3], index:3, elapsed:${elapsed}}, false)`,
      ),
    );
    for (const frame of movingFrames) {
      expect(frame.sprite.length).toBeGreaterThan(0);
      expect(frame.sprite.flat().every(Number.isFinite)).toBe(true);
      expect(frame.streaks.flat().every(Number.isFinite)).toBe(true);
    }
    expect(movingFrames[3].sprite).not.toEqual(movingFrames[4].sprite);

    for (const name of ["orbit", "signal", "original", "bee"]) {
      win.dispatchEvent(
        new win.KeyboardEvent("keydown", { key: "ArrowRight" }),
      );
      expect(run("variation")).toBe(name);
      const frame = run(
        "variation==='original'?drawOriginal({phase:phases[3],index:3,elapsed:1100},true):variation==='bee'?draw('orbit',{phase:phases[3],index:3,elapsed:1100},true):drawInstrument({phase:phases[3],index:3,elapsed:1100},true)",
      );
      expect(frame.white.every(Number.isFinite)).toBe(true);
      for (let key = 0; key <= 9; key++) {
        win.dispatchEvent(
          new win.KeyboardEvent("keydown", { key: String(key) }),
        );
        run("render(performance.now())");
        expect(
          win.document.getElementById("display").getAttribute("aria-label"),
        ).toContain("Visual state preview");
      }
    }
    expect(win.document.querySelector("select")).toBeNull();
    win.dispatchEvent(new win.KeyboardEvent("keydown", { key: "ArrowLeft" }));
    expect(run("variation")).toBe("original");
    status = { generation: 1, state: "running", available: true, usage: null };
    await run("poll()");
    expect(run("model.valid")).toBe(true);
    expect(run("model.phase")).toBe("online");
    run("render(performance.now())");
    expect(
      win.document.getElementById("display").getAttribute("aria-label"),
    ).not.toContain("Status unavailable");
    status = { generation: 2, state: "starting", usage: null };
    await run("poll()");
    expect(run("model.total")).toBe(null);
    expect(run("model.phase")).toBe("link");
    status = { generation: 2, state: "failed", usage: null };
    await run("poll()");
    expect(run("model.phase")).toBe("error");
    const timers = new Map();
    win.setTimeout = (callback, delay) => {
      timers.set(delay, callback);
      return delay;
    };
    win.clearTimeout = (delay) => timers.delete(delay);
    win.console.warn = () => {};
    let finishLate;
    read = () =>
      new Promise((resolve) => {
        finishLate = resolve;
      });
    const pending = run("poll()");
    timers.get(8000)();
    await pending;
    expect(timers.has(1000)).toBe(true);
    read = async () => ({
      generation: 3,
      state: "running",
      usage: { tokensServed: 7, inflight: 0 },
    });
    await run("poll()");
    finishLate({
      generation: 1,
      state: "running",
      usage: { tokensServed: 999, inflight: 1 },
    });
    await Promise.resolve();
    expect(run("model.total")).toBe(7);
    win.dispatchEvent(new win.KeyboardEvent("keydown", { key: "4" }));
    expect(run("inspectedState.index")).toBe(3);
    expect(win.document.body.textContent).not.toContain("PREVIEW");
    win.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape" }));
    expect(run("inspectedState")).toBeNull();

    const tones = [];
    const param = { setValueAtTime() {}, exponentialRampToValueAtTime() {} };
    win.AudioContext = class {
      currentTime = 0;
      destination = {};
      createGain() {
        return { gain: param, connect: (node) => node };
      }
      createOscillator() {
        const tone = {
          frequency: {},
          connect: (node) => node,
          start() {},
          stop() {},
        };
        tones.push(tone);
        return tone;
      }
    };
    run("setPhase('error'); lastCue = -Infinity");
    expect(tones).toHaveLength(0);
    win.dispatchEvent(new win.KeyboardEvent("keydown", { key: "s" }));
    expect(run("sound")).toBe(true);
    expect(win.localStorage.getItem("mesh-buddy-sound")).toBe("on");
    expect(tones.map((tone) => tone.frequency.value)).toEqual([659, 988]);
    run("lastCue = -Infinity; setPhase('online')");
    expect(tones).toHaveLength(4);
    run(
      "lastCue = -Infinity; setPhase('complete'); lastCue = -Infinity; setPhase('online')",
    );
    expect(tones).toHaveLength(6);
    win.dispatchEvent(new win.KeyboardEvent("keydown", { key: "s" }));
    run("lastCue = -Infinity; setPhase('error')");
    expect(tones).toHaveLength(6);
    expect(win.localStorage.getItem("mesh-buddy-sound")).toBe("off");

    const display = win.document.getElementById("display");
    const pointer = (type, x = 0) =>
      display.dispatchEvent(
        new win.MouseEvent(type, { button: 0, screenX: x, screenY: 0 }),
      );
    const commands = () => calls.map(([command]) => command);
    const before = run("variation");
    pointer("pointerdown");
    pointer("pointermove", 2);
    pointer("pointerup", 2);
    expect(run("variation")).not.toBe(before);
    expect(commands()).not.toContain("plugin:window|start_dragging");
    const clicked = run("variation");
    pointer("pointerdown");
    pointer("pointermove", 12);
    pointer("pointerup", 12);
    expect(commands()).toContain("plugin:window|start_dragging");
    expect(run("variation")).toBe(clicked);
    display.dispatchEvent(
      new win.WheelEvent("wheel", { deltaY: 60, cancelable: true }),
    );
    const [, resized] = calls.find(
      ([command]) => command === "plugin:window|set_size",
    );
    expect(resized.value.Logical.width).toBe(resized.value.Logical.height);
    expect(resized.value.Logical.width).toBeGreaterThanOrEqual(96);
    expect(resized.value.Logical.width).toBeLessThanOrEqual(320);
    calls.length = 0;
    read = async () => ({
      sharing: true,
      state: "running",
      available: true,
      usage: null,
    });
    await run("poll()");
    expect(commands()).not.toContain("plugin:window|close");
    // Keep enforcing visibility even when a visual preview is selected.
    win.dispatchEvent(new win.KeyboardEvent("keydown", { key: "0" }));
    read = async () => ({
      sharing: false,
      state: "running",
      available: true,
      usage: null,
    });
    await run("poll()");
    expect(commands()).toContain("plugin:window|close");
    expect(commands()).not.toContain("mesh_compute_stop");
    calls.length = 0;
    const settings = win.document.getElementById("widget-settings");
    const menu = win.document.getElementById("settings-toggle");
    expect(settings.hidden).toBe(true);
    menu.click();
    expect(settings.hidden).toBe(false);
    expect(menu.getAttribute("aria-expanded")).toBe("true");
    const beforeSettings = run("variation");
    win.dispatchEvent(new win.KeyboardEvent("keydown", { key: "ArrowRight" }));
    expect(run("variation")).toBe(beforeSettings);
    win.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape" }));
    expect(settings.hidden).toBe(true);
    expect(win.document.activeElement).toBe(menu);
    win.dispatchEvent(
      new win.KeyboardEvent("keydown", { key: ",", metaKey: true }),
    );
    expect(settings.hidden).toBe(false);
    win.document.getElementById("close").click();
    expect(commands()).toContain("plugin:window|close");
    expect(commands()).not.toContain("mesh_compute_stop");
  } finally {
    dom.window.close();
  }
});

it("embedded activity consumes only its parent feed and never invokes native window controls", () => {
  const dom = new JSDOM(
    readFileSync(new URL("../compute-widget.html", import.meta.url), "utf8"),
    {
      runScripts: "outside-only",
      url: "http://localhost/compute-widget.html?embedded=true",
    },
  );
  try {
    const win = dom.window;
    win.matchMedia = () => ({ matches: true });
    win.HTMLCanvasElement.prototype.getContext = () =>
      new Proxy({}, { get: () => () => {} });
    win.requestAnimationFrame = () => 0;
    win.setTimeout = () => 0;
    win.clearTimeout = () => {};
    const calls = [];
    win.__TAURI_INTERNALS__ = {
      invoke: (...args) => {
        calls.push(args);
        return Promise.resolve({});
      },
    };
    const run = (code) => vm.runInContext(code, dom.getInternalVMContext());
    run(
      readFileSync(
        new URL("../public/compute-widget.js", import.meta.url),
        "utf8",
      ),
    );
    const send = (origin, sharing) =>
      win.dispatchEvent(
        new win.MessageEvent("message", {
          source: win.parent,
          origin,
          data: {
            type: "compute-activity",
            status: {
              available: true,
              generation: sharing,
              sharing,
              state: sharing ? "running" : "off",
              usage: sharing
                ? {
                    tokensServed: 42,
                    inflight: 1,
                    peers: 1,
                    tokensPerSecond: 5,
                  }
                : null,
            },
          },
        }),
      );
    send("http://other.example", true);
    expect(run("model.total")).toBe(null);
    send("http://localhost", true);
    expect(run("model.total")).toBe(42);
    expect(run("model.phase")).toBe("active");
    send("http://localhost", false);
    expect(run("model.phase")).toBe("offline");
    expect(calls).toEqual([]);
    expect(win.document.getElementById("close").hidden).toBe(true);
    expect(win.document.getElementById("settings-toggle").hidden).toBe(true);
    win.dispatchEvent(
      new win.KeyboardEvent("keydown", { key: ",", metaKey: true }),
    );
    expect(win.document.getElementById("widget-settings").hidden).toBe(true);
  } finally {
    dom.window.close();
  }
});

it("repaints the widget with the current theme surface and ink", () => {
  const dom = new JSDOM(
    readFileSync(new URL("../compute-widget.html", import.meta.url), "utf8"),
    {
      runScripts: "outside-only",
      url: "http://localhost/compute-widget.html?embedded=true",
    },
  );
  try {
    const win = dom.window;
    win.requestAnimationFrame = () => 0;
    win.matchMedia = () => ({ matches: true });
    const paints = [];
    const drawing = new Proxy(
      {},
      {
        get: (target, key) => (key in target ? target[key] : () => {}),
        set: (target, key, value) => {
          target[key] = value;
          if (key === "fillStyle") paints.push(value);
          return true;
        },
      },
    );
    win.HTMLCanvasElement.prototype.getContext = () => drawing;
    const root = win.document.documentElement;
    root.style.setProperty("--surface-inset", "rgb(245, 245, 245)");
    root.style.setProperty("--text-standard", "rgb(20, 20, 20)");
    root.style.setProperty("--text-danger", "rgb(180, 0, 0)");
    const run = (code) => vm.runInContext(code, dom.getInternalVMContext());
    run(
      readFileSync(
        new URL("../public/compute-widget.js", import.meta.url),
        "utf8",
      ),
    );
    run("render(100, false)");
    expect(paints[0]).toBe("rgb(245, 245, 245)");
    expect(paints.some((color) => color.includes("rgb(20, 20, 20)"))).toBe(
      true,
    );
    // The same animation can paint for hardware with an independent dark
    // palette while the visible desktop widget remains in light mode.
    let hardwareFrame;
    win.document.getElementById("display").addEventListener(
      "compute-frame",
      (event) => {
        hardwareFrame = event.detail;
      },
      { once: true },
    );
    run("render(150, false)");
    const device = win.document.createElement("canvas");
    device.style.setProperty("--surface-inset", "rgb(16, 16, 16)");
    device.style.setProperty("--text-standard", "rgb(240, 240, 240)");
    device.style.setProperty("--text-danger", "rgb(255, 100, 100)");
    win.document.body.append(device);
    paints.length = 0;
    hardwareFrame.paint(drawing, 128, 128, win.getComputedStyle(device));
    expect(paints[0]).toBe("rgb(16, 16, 16)");
    expect(paints.some((color) => color.includes("rgb(240, 240, 240)"))).toBe(
      true,
    );
    expect(root.style.getPropertyValue("--surface-inset")).toBe(
      "rgb(245, 245, 245)",
    );
    paints.length = 0;
    root.style.setProperty("--surface-inset", "rgb(16, 16, 16)");
    root.style.setProperty("--text-standard", "rgb(240, 240, 240)");
    run("render(200, false)");
    expect(paints[0]).toBe("rgb(16, 16, 16)");
    expect(paints.some((color) => color.includes("rgb(240, 240, 240)"))).toBe(
      true,
    );
    expect(drawing.globalAlpha).toBe(1);
  } finally {
    dom.window.close();
  }
});
