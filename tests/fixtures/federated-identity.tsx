// Public UI state only: no IPC, account credentials, browser handoff or relay.
import { createRoot } from "react-dom/client";
import { useEffect, useState, useSyncExternalStore } from "react";
import { CommunitySignIn } from "../../src/features/federated-identity/CommunitySignIn";
import type {
  FederatedIdentity,
  SessionSnapshot,
} from "../../src/features/federated-identity/service";
import styles from "../../src/app/Settings.module.css";
import { Button } from "../../src/shared/design-system/ui/Button";
import "../../src/shared/styles/globals.css";
let state: SessionSnapshot = {
  status: "signed-out",
  authority: {
    id: "fixture",
    identityOrigin: "https://identity.example",
    apiBasePath: "/api/",
  },
  revision: "out",
  email: null,
  failure: null,
};
const listeners = new Set<() => void>();
const publish = (patch: Partial<SessionSnapshot>) => {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
};
const identity: FederatedIdentity = {
  snapshot: () => state,
  subscribe(listener) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  async signIn() {
    publish({ status: "signing-in", failure: null });
    return state;
  },
  async cancelSignIn() {
    publish({
      status: "signed-out",
      revision: crypto.randomUUID(),
      failure: null,
    });
  },
  async signInLink() {
    return null;
  },
  async signOut() {
    publish({
      status: "signed-out",
      revision: crypto.randomUUID(),
      email: null,
      failure: null,
    });
  },
};
function Fixture() {
  const snapshot = useSyncExternalStore(identity.subscribe, identity.snapshot);
  const [theme, setTheme] = useState("light");
  useEffect(() => {
    document.documentElement.dataset.colorMode = theme;
  }, [theme]);
  return (
    <div className="min-h-screen bg-panel text-primary">
      <aside className="flex flex-wrap gap-2 p-4" aria-label="Fixture controls">
        <p className="text-body-sm">
          Public UI fixture only. No OS storage or live login.
        </p>
        <Button onClick={() => setTheme(theme === "light" ? "dark" : "light")}>
          Switch theme
        </Button>
        <Button
          onClick={() =>
            publish({
              status: "signed-in",
              revision: crypto.randomUUID(),
              email: null,
              failure: null,
            })
          }
        >
          Complete
        </Button>
        <Button
          onClick={() =>
            publish({ status: "signed-out", failure: "storage-denied" })
          }
        >
          Storage failure
        </Button>
        <Button
          onClick={() =>
            publish({ status: "signed-in", failure: "binding-mismatch" })
          }
        >
          Binding mismatch
        </Button>
      </aside>
      <main className={`${styles.detail} buzz-settings-page`}>
        <div>
          <CommunitySignIn
            identity={identity}
            error={
              snapshot.failure === "binding-mismatch"
                ? snapshot.failure
                : "Federated sign-in is required"
            }
            retry={() => {}}
          />
        </div>
      </main>
    </div>
  );
}
const root = document.getElementById("root");
if (root) createRoot(root).render(<Fixture />);
