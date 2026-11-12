// Controlled component state; no credentials, relay, or live account.
import { createRoot } from "react-dom/client";
import { useState } from "react";
import { IdentitySettings } from "../../src/app/IdentitySettings";
import { BuilderlabIdentityRow } from "../../src/bundled/builderlab/login/IdentityRow";
import type { BuilderlabSession } from "../../src/bundled/builderlab/session";
import type { Identity } from "../../src/features/identity/service";
import type { BackupStatus } from "../../src/features/identity/backup";
import type {
  FederatedIdentity,
  SessionSnapshot,
} from "../../src/features/federated-identity/service";
import { Dialog } from "../../src/shared/design-system/ui/Dialog";
import { ToastProvider } from "../../src/shared/design-system/ui/Toast";
import { useKeyboardFocusVisibility } from "../../src/shared/design-system/useKeyboardFocusVisibility";
import "../../src/shared/styles/globals.css";
import "@fontsource-variable/inter/wght.css";

const accounts = new URLSearchParams(location.search).has("accounts");
const viewer = "ab".repeat(32);
const status: BackupStatus = {
  seq: 1,
  pass: 1,
  builderlab: !accounts,
  status: "failed",
  kind: "unconfirmed",
  management: {
    pubkey: viewer,
    policy: "organization-managed",
    initialBackupConfirmed: false,
  },
};
const listeners = new Set<() => void>();
const forbidden = async () => {
  throw new Error(
    "Layout fixture cannot sign in, upload, export or remove keys",
  );
};
const identity = {
  backup: {
    snapshot: () => status,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    ready: async () => status,
    refresh: async () => status,
    retry: forbidden,
  },
  exportKey: forbidden,
  signOut: forbidden,
  wipeRefusal: async () => "Removal is unavailable in this fixture",
} as unknown as Identity;
function session(
  id: string,
  organization: string | null,
  signedIn: boolean,
): FederatedIdentity {
  const state: SessionSnapshot = {
    status: signedIn ? "signed-in" : "signed-out",
    authority: {
      id,
      identityOrigin: `https://${id}`,
      apiBasePath: "/api/",
      signIn: "on-demand",
      organization,
      communityHosts: [],
    },
    revision: id,
    email: signedIn ? "member@example.com" : null,
    expiresAt: signedIn
      ? new Date(Date.now() + 86_400_000).toISOString()
      : null,
    expiring: false,
    cleanup: false,
    failure: null,
  };
  return {
    apiAvailable: true,
    snapshot: () => state,
    subscribe: () => () => {},
    signIn: forbidden,
    cancelSignIn: forbidden,
    signOut: forbidden,
    request: forbidden,
  };
}
const primary = session("accounts.example.org", "Example Org", true);
const secondary = session("app.builderlab.xyz", null, false);
const federated = {
  ...primary,
  forServer: (id: string) =>
    id === "accounts.example.org" ? primary : secondary,
};
const servers = async () => [primary.snapshot(), secondary.snapshot()];
const login = {
  status: "signed-in",
  account: {
    subject: "fixture",
    email: "member@example.com",
    canUseRemoteAgents: true,
    canUseBuilderlabDecisions: false,
  },
} as const;
const builderlab = {
  providerName: "Example Org",
  snapshot: () => login,
  subscribe: () => () => {},
} as BuilderlabSession;
function Fixture() {
  useKeyboardFocusVisibility();
  const [open, setOpen] = useState(true);
  return (
    <ToastProvider>
      <Dialog
        open={open}
        title="Settings"
        size="expanded"
        onOpenChange={setOpen}
      >
        <div className="buzz-settings-page">
          <IdentitySettings
            viewer={viewer}
            identity={identity}
            federatedIdentity={accounts ? federated : undefined}
            servers={accounts ? servers : undefined}
            accountRows={
              accounts && (
                <BuilderlabIdentityRow
                  session={builderlab}
                  active={() => true}
                  openSettings={() => {}}
                />
              )
            }
          />
        </div>
      </Dialog>
    </ToastProvider>
  );
}
const root = document.getElementById("root");
if (root) createRoot(root).render(<Fixture />);
