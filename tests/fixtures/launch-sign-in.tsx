// Public UI state only: no IPC, account credentials, browser handoff or relay.
import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import {
  LaunchSignIn,
  SignInEnding,
} from "../../src/features/federated-identity/LaunchSignIn";
import type {
  FederatedIdentity,
  SessionSnapshot,
} from "../../src/features/federated-identity/service";
import { Button } from "../../src/shared/design-system/ui/Button";
import { Dialog } from "../../src/shared/design-system/ui/Dialog";
import { ToastProvider } from "../../src/shared/design-system/ui/Toast";
import "../../src/shared/styles/globals.css";

const params = new URLSearchParams(location.search);
let state: SessionSnapshot = {
  status: "restoring",
  authority: {
    id: "fixture",
    identityOrigin: "https://identity.example",
    apiBasePath: "/api/goose/",
    signIn: "at-launch",
    organization: params.has("unnamed") ? null : "Block",
  },
  revision: "launch",
  email: null,
  failure: null,
  expiresAt: null,
  expiring: false,
};
const listeners = new Set<() => void>();
let renewal: ReturnType<typeof setTimeout> | undefined;
let finishRenewal: (value?: unknown) => void = () => {};
const publish = (patch: Partial<SessionSnapshot>) => {
  state = { ...state, ...patch, revision: crypto.randomUUID() };
  for (const listener of listeners) listener();
};
const identity: FederatedIdentity = {
  apiAvailable: true,
  snapshot: () => state,
  subscribe(listener) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  async signIn() {
    // Signing in again while signed in keeps the app open; the browser
    // "finishes" after 3 seconds unless canceled.
    if (state.status === "signed-in") {
      renewal = setTimeout(
        () => publish({ expiring: false, expiresAt: null }),
        3000,
      );
      await new Promise((done) => {
        finishRenewal = done;
        setTimeout(done, 3000);
      });
      return state;
    }
    publish({ status: "signing-in", failure: null });
    return state;
  },
  async cancelSignIn() {
    if (state.status === "signed-in") {
      clearTimeout(renewal);
      finishRenewal();
      return;
    }
    publish({ status: "signed-out", failure: null });
  },
  async signInLink() {
    return state.status === "signing-in"
      ? "https://identity.example/v1/login/start"
      : null;
  },
  async signOut() {
    publish({ status: "signed-out", email: null, failure: null });
  },
  async request() {
    throw new Error("Fixture has no network");
  },
};

const states: Record<string, Partial<SessionSnapshot>> = {
  "Signed in": { status: "signed-in", email: "you@example.com", failure: null },
  Canceled: { status: "signed-out", failure: null },
  Failed: { status: "signed-out", failure: "callback-refused" },
  Ended: { status: "reauthentication-required", failure: null },
  Unreachable: { status: "unavailable", failure: "network-unavailable" },
  Storage: { status: "unavailable", failure: "storage-denied" },
  Expiring: {
    status: "signed-in",
    failure: null,
    expiring: true,
    expiresAt: new Date(Date.now() + 26 * 60 * 60 * 1000).toISOString(),
  },
};

function Fixture() {
  const [theme, setTheme] = useState(params.get("theme") ?? "light");
  const [dialog, setDialog] = useState(params.has("midrun"));
  useEffect(() => {
    document.documentElement.dataset.colorMode = theme;
  }, [theme]);
  return (
    <ToastProvider>
      <SignInEnding identity={identity} />
      <LaunchSignIn identity={identity}>
        <main className="grid min-h-screen place-items-center bg-panel text-primary">
          <textarea aria-label="Draft" placeholder="The app, signed in" />
        </main>
        <Dialog
          open={dialog}
          onOpenChange={setDialog}
          title="A dialog the app had open"
        >
          The session ends while this is open.
        </Dialog>
      </LaunchSignIn>
      {!params.has("bare") && (
        <aside
          className="fixed bottom-2 left-2 z-50 flex flex-wrap gap-1"
          aria-label="Fixture controls"
        >
          <Button
            onClick={() => setTheme(theme === "light" ? "dark" : "light")}
          >
            Theme
          </Button>
          {Object.entries(states).map(([name, patch]) => (
            <Button key={name} onClick={() => publish(patch)}>
              {name}
            </Button>
          ))}
        </aside>
      )}
    </ToastProvider>
  );
}
const root = document.getElementById("root");
if (root) createRoot(root).render(<Fixture />);
// Launch settles signed out, which starts sign-in; `?state=Name` then moves
// to that state, for screenshots. `?midrun` opens signed in, with a dialog
// open, and the session ends a moment later.
if (params.has("midrun")) {
  setTimeout(() => publish({ status: "signed-in" }), 50);
  setTimeout(() => publish({ status: "reauthentication-required" }), 600);
} else setTimeout(() => publish({ status: "signed-out" }), 50);
const initial = states[params.get("state") ?? ""];
if (initial) setTimeout(() => publish(initial), 150);
