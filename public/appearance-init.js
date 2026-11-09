// Parser-blocking, same-origin bootstrap: no inline-script CSP exception required.
// Keep key/fallback aligned with shared/theme/service.ts (covered by service.test.ts).
(() => {
  let mode =
    typeof matchMedia === "function" &&
    matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  try {
    const preference = localStorage.getItem("buzz-appearance.v1");
    if (preference === "light" || preference === "dark") mode = preference;
  } catch {
    // Storage may be denied; the system palette still opens safely.
  }
  document.documentElement.dataset.colorMode = mode;
  let accent = "citrus";
  try {
    const accents = ["bee", "magenta", "iris", "cobalt", "citrus", "mono"];
    let value = localStorage.getItem("buzz-accent.v1");
    if (value === null) {
      // The former bubble color carries over; its old "Default" does not.
      const legacy = {
        blue: "cobalt",
        cyan: "cobalt",
        indigo: "cobalt",
        green: "citrus",
        orange: "bee",
        pink: "magenta",
        red: "magenta",
        lilac: "iris",
        purple: "iris",
      };
      value = legacy[localStorage.getItem("buzz-bubble-color.v1")] ?? null;
    }
    if (
      value === "chartreuse" ||
      value === "lime" ||
      value === "pear" ||
      value === "jade"
    )
      value = "citrus";
    if (value === "flame") value = "bee";
    if (value === "gray") value = "mono";
    if (accents.includes(value)) accent = value;
  } catch {
    /* The default accent remains usable without storage. */
  }
  document.documentElement.dataset.accent = accent;
  let contrast = "low";
  try {
    const saved = localStorage.getItem("buzz-contrast.v1");
    if (saved === "high") contrast = saved;
  } catch {
    /* Low contrast remains usable without storage. */
  }
  document.documentElement.dataset.colorLevel =
    contrast === "low" ? "touch" : contrast;
  let messageWidth = "52rem";
  try {
    if (localStorage.getItem("buzz-message-width.v1") === "wide")
      messageWidth = "78rem";
  } catch {
    /* Narrow remains usable without storage. */
  }
  document.documentElement.style.setProperty(
    "--buzz-message-width",
    messageWidth,
  );
  let density = "default";
  try {
    if (localStorage.getItem("buzz-message-density.v1") === "compact")
      density = "compact";
  } catch {
    /* Default spacing remains usable without storage. */
  }
  document.documentElement.dataset.messageDensity = density;
  let scale = 1;
  try {
    const value = Number(localStorage.getItem("buzz-font-scale.v1"));
    if (Number.isFinite(value) && value >= 0.8 && value <= 2)
      scale = Math.round(value * 10) / 10;
  } catch {
    /* Text remains readable when storage is unavailable. */
  }
  document.documentElement.style.setProperty(
    "--buzz-text-scale",
    String(scale),
  );
})();
