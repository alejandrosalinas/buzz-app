import { useEffect, useState, useSyncExternalStore } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { Accordion } from "../../shared/design-system/ui/Accordion";
import { Button } from "../../shared/design-system/ui/Button";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { ArrowsClockwiseIcon } from "../../shared/design-system/icons";
import { Header } from "../../shared/design-system/ui/Header";
import {
  buildIdentity,
  describeBuildIdentity,
  type BuildIdentity,
} from "../../shared/build-identity";
import type { Updates } from "./updates";

export function UpdateSettings({
  updates,
  active,
}: {
  updates: Updates;
  active: boolean;
}) {
  const frontendIdentity = buildIdentity(
    import.meta.env.VITE_BUZZ_FRONTEND_SOURCE_REVISION,
    import.meta.env.VITE_BUZZ_FRONTEND_SOURCE_STATE,
  );
  const status = useSyncExternalStore(
    updates.subscribe,
    updates.snapshot,
    updates.snapshot,
  );
  useEffect(
    () => (active ? updates.showInline() : undefined),
    [active, updates],
  );
  // Browser builds have no native version; leave it unset there.
  const [version, setVersion] = useState<string | null>(null);
  const [nativeIdentity, setNativeIdentity] = useState<BuildIdentity>(() =>
    buildIdentity(null, null),
  );
  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    getVersion()
      .then((found) => {
        if (!cancelled) setVersion(found);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    invoke<BuildIdentity>("get_build_identity")
      .then((identity) => {
        if (!cancelled)
          setNativeIdentity(buildIdentity(identity?.revision, identity?.state));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  const pending = [
    "checking",
    "available",
    "downloading",
    "installing",
  ].includes(status.state);
  const messages = {
    idle: "Check if a new version is available.",
    checking: "Checking for updates…",
    "up-to-date": "You're on the latest version.",
    unavailable:
      "Automatic updates aren't available on this build. Download the latest release manually.",
    available: "Preparing update…",
    downloading: "Downloading update…",
    installing: "Installing update…",
    ready: "Ready to install. Buzz will restart.",
    error: "",
  };
  const label =
    status.state === "ready" || status.state === "installing"
      ? "Update now"
      : status.state === "error"
        ? "Retry"
        : status.state === "up-to-date" || status.state === "unavailable"
          ? "Check again"
          : "Check for updates";
  return (
    <section aria-labelledby="update-settings-title">
      <Header id="update-settings-title" title="Software updates" />
      <EmptyState
        icon={<ArrowsClockwiseIcon />}
        title={version ? `Version ${version}` : "Update status"}
        description={
          <span role="status">
            {status.state === "error" ? (
              <span className="error">Update failed: {status.message}</span>
            ) : (
              messages[status.state]
            )}
          </span>
        }
        action={
          <Button
            type="button"
            loading={pending}
            onClick={() =>
              void (status.state === "ready"
                ? updates.installAndRelaunch()
                : updates.checkForUpdate())
            }
          >
            {label}
          </Button>
        }
      />
      {isTauri() && (
        <Accordion
          variant="settings"
          items={[
            {
              value: "Build details",
              title: "Build details",
              content: (
                <div className="grid gap-2 text-body-sm wrap-anywhere">
                  <p>
                    Native image source: {describeBuildIdentity(nativeIdentity)}
                  </p>
                  <p>
                    Loaded frontend source:{" "}
                    {describeBuildIdentity(frontendIdentity)}
                  </p>
                </div>
              ),
            },
          ]}
        />
      )}
    </section>
  );
}
