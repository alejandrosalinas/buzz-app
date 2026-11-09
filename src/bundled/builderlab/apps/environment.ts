// Which Apps Platform a Builderlab sign-in deploys to: the control plane of
// the same tenant, since its session is only valid there. A build's
// `BUZZ_BUILDERLAB_APPS_CONTROL_PLANE` serves its own login origin. Kept in step
// with `apps_control_plane` in crates/plugin-manager, which grants the plugin
// that origin.
const CONTROL_PLANES: Readonly<Record<string, string>> = {
  "https://app.builderlab.xyz": "https://compose-ctrl.builderlab.xyz",
  "https://app.builderlabstaging.xyz":
    "https://compose-ctrl.builderlabstaging.xyz",
};

/** The control plane for the configured Builderlab URL, if it has one. */
export function controlPlane(
  value = import.meta.env.VITE_BUZZ_BUILDERLAB_URL ?? "",
  login = import.meta.env.VITE_BUZZ_BUILDERLAB_URL ?? "",
  configured = import.meta.env.VITE_BUZZ_BUILDERLAB_APPS_CONTROL_PLANE ?? "",
) {
  try {
    const origin = new URL(value).origin;
    if (configured && login && origin === new URL(login).origin) {
      return configured;
    }
    return CONTROL_PLANES[origin];
  } catch {
    return undefined;
  }
}

/** DNS labels are 1–63 alphanumeric characters, with interior hyphens allowed. */
const DNS_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
/** App subdomains under apps.[<tenant>.]builderlab[staging].xyz. */
const APP_DOMAINS = new RegExp(
  `^(?:${DNS_LABEL}\\.)+apps\\.(?:${DNS_LABEL}\\.)?builderlab(?:staging)?\\.xyz$`,
);

/** An app's name from its host, `<name>--<workspace>.<apps domain>`. */
export function appName(target: string) {
  try {
    return new URL(target).hostname.split(".")[0]?.split("--")[0] || undefined;
  } catch {
    return undefined;
  }
}

/** Whether `target` is a deployed app's page. */
export function isAppUrl(target: string) {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  const viewerDomain = viewerAppDomain();
  return (
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    (APP_DOMAINS.test(host) ||
      (!!viewerDomain && host.endsWith(`.${viewerDomain}`)))
  );
}

/** Trusted build configuration, paired with the configured login origin. Empty disables native SSO. */
export function viewerAppDomain(
  origin = import.meta.env.VITE_BUZZ_BUILDERLAB_URL ?? "",
  configured: string | undefined = import.meta.env
    .VITE_BUZZ_BUILDERLAB_APPS_DOMAIN,
): string {
  if (configured !== undefined) return configured;
  try {
    return new URL(origin).origin === "https://app.builderlab.xyz"
      ? "apps.builderlab.xyz"
      : "";
  } catch {
    return "";
  }
}

/** A credential is only exchanged for app hosts in the same configured tenant. */
export function isViewerTarget(
  target: string,
  origin = import.meta.env.VITE_BUZZ_BUILDERLAB_URL ?? "",
  domain = viewerAppDomain(origin),
) {
  try {
    const url = new URL(target);
    const login = new URL(origin);
    const label = domain && url.hostname.slice(0, -(domain.length + 1));
    return (
      login.protocol === "https:" &&
      !login.username &&
      !login.password &&
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      Boolean(
        domain &&
          url.port === "" &&
          url.hostname.endsWith(`.${domain}`) &&
          label &&
          !label.includes(".") &&
          label !== "login" &&
          label !== "health",
      )
    );
  } catch {
    return false;
  }
}
