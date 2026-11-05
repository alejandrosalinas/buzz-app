/**
 * Whether this device was set up through Builderlab, so a relaunch signs in
 * to check with the account before the app opens. A device set up any other
 * way (self-hosted, or before this note existed) opens straight to the app.
 */
const KEY = "buzz.setup-route.v1";

export function setUpWithBuilderlab(): boolean {
  try {
    return localStorage.getItem(KEY) === "builderlab";
  } catch {
    return false;
  }
}

export function rememberBuilderlab() {
  try {
    localStorage.setItem(KEY, "builderlab");
  } catch {
    // Storage refused: the next launch opens straight to the app, as today.
  }
}

export function forgetBuilderlab() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing saved to forget.
  }
}
