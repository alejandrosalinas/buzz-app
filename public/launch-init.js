// Keep the SVG's first frame tied to the parser-created loader, before React runs.
const launch = document.getElementById("buzz-launch");
const mark = launch?.querySelector("img");
if (launch && mark) {
  const loaded = () => {
    launch.dataset.startedAt = String(performance.now());
  };
  const failed = () => {
    launch.dataset.failed = "true";
  };
  if (mark.complete) {
    if (mark.naturalWidth) loaded();
    else failed();
  } else {
    mark.addEventListener("load", loaded, { once: true });
    mark.addEventListener("error", failed, { once: true });
  }
}

// What shows when Buzz can't go on. "Buzz couldn’t open": the app bundle never
// loaded, threw before React took over, or React unmounted the app before its
// launch ended. "Buzz stopped working": React unmounted it, after an error no
// boundary caught, once the launch had ended. None of it may use the bundle,
// which is what failed. The bundle reaches it as `window.__buzzStartup`; see
// src/app/launch.ts.
(() => {
  // A slow start offers Reload; the launch still leaves by itself if it ends.
  const SLOW_MS = 20_000;
  const native = window.__TAURI_INTERNALS__;
  let started = false;
  let failure;
  let slow;

  const text = (error) => {
    if (error instanceof Error) {
      const head = `${error.name}: ${error.message}`;
      const stack = error.stack ?? "";
      return stack.startsWith(head) ? stack : [head, stack].join("\n").trim();
    }
    if (typeof error === "string") return error;
    try {
      return JSON.stringify(error) ?? String(error);
    } catch {
      return String(error);
    }
  };
  const element = (tag, className, content) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content) node.textContent = content;
    return node;
  };
  const button = (label, action, prominent = false) => {
    const node = element("button", "buzz-startup-button", label);
    node.type = "button";
    if (prominent) node.dataset.prominent = "";
    node.addEventListener("click", action);
    return node;
  };
  const reload = () => location.reload();
  // A first-welcome Mac window starts hidden; the user must see this.
  const reveal = () => {
    const root = document.documentElement;
    if (root.dataset.welcomeIntro === undefined) return;
    delete root.dataset.welcomeIntro;
    void native
      ?.invoke("plugin:window|show", { label: "main" })
      .catch(() => {});
  };

  function failed(error, detail) {
    const details = [text(error), detail].filter(Boolean).join("\n").trim();
    if (failure) {
      // Later failures add to Details, for support.
      const shown = failure.textContent;
      if (details && !shown.includes(details))
        failure.textContent = `${shown}\n\n${details}`.slice(0, 8000);
      return;
    }
    clearTimeout(slow);
    reveal();
    // React had the app and the launch had ended: the user was using Buzz.
    const launch = document.getElementById("buzz-launch");
    const running = started && !launch;
    launch?.remove();
    for (const id of ["root", "buzz-toast-root"]) {
      const root = document.getElementById(id);
      if (!root) continue;
      root.hidden = true;
      root.setAttribute("inert", "");
      root.setAttribute("aria-hidden", "true");
    }
    const page = element("main", "buzz-startup-failure");
    page.id = "buzz-startup-failure";
    page.setAttribute("aria-labelledby", "buzz-startup-failure-title");
    const content = element("div", "buzz-startup-content");
    const message = element("div", "buzz-startup-message");
    message.setAttribute("role", "alert");
    const title = element(
      "h1",
      "",
      running ? "Buzz stopped working" : "Buzz couldn’t open",
    );
    title.id = "buzz-startup-failure-title";
    message.append(
      title,
      element(
        "p",
        "",
        running
          ? "Something went wrong. Your messages and settings are safe."
          : "Something went wrong while starting. Your messages and settings are safe.",
      ),
    );
    const actions = element("div", "buzz-startup-actions");
    const first = button("Reload", reload, true);
    actions.append(first);
    if (native)
      actions.append(
        button("Restart Buzz", () => {
          void native.invoke("update_restart").catch(reload);
        }),
      );
    const disclosure = element("details", "buzz-startup-details");
    failure = element("pre", "", details.slice(0, 8000));
    disclosure.append(element("summary", "", "Details"), failure);
    content.append(message, actions, disclosure);
    page.append(content);
    document.body.append(page);
    first.focus();
  }

  // Until React has the app, an uncaught error or rejection, or a script that
  // didn't load, is a failed startup. After that, React's own error reaches
  // `failed` through the root; other errors leave the app running.
  addEventListener(
    "error",
    (event) => {
      if (started) return;
      const target = event.target;
      if (target instanceof HTMLScriptElement)
        failed(`Couldn’t load ${target.src || "a startup script"}`);
      else if (!(target instanceof Element))
        failed(event.error ?? event.message);
    },
    true,
  );
  addEventListener("unhandledrejection", (event) => {
    if (!started) failed(event.reason);
  });

  slow = setTimeout(() => {
    const launch = document.getElementById("buzz-launch");
    if (!launch || failure || launch.classList.contains("buzz-launch--leaving"))
      return;
    reveal();
    // The launch is a status region, so this is read when it appears.
    const notice = element("div", "buzz-launch-slow");
    notice.append(
      element("p", "", "This is taking longer than usual."),
      button("Reload", reload),
    );
    launch.append(notice);
  }, SLOW_MS);

  window.__buzzStartup = Object.freeze({
    failed,
    started() {
      started = true;
    },
  });
})();
