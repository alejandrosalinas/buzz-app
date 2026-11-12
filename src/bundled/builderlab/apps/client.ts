// The Apps Platform control plane, called with the plugin's Builderlab
// sign-in as `bl apps` calls it (block/builderlab-cli `src/bl/apps.rs`): the
// transport sends the session as `Authorization: BBIdentity <session>`, and
// the gateway exchanges it for the control plane's own token.
import type { FederatedIdentity } from "../../../features/federated-identity/service";
import type { Host, HostResponse } from "../../../features/host/service";
import type { BuilderlabSession } from "../session";

/** The Apps protocol `bl` speaks, which the control plane checks. */
const PROTOCOL = "0.2.0";
export type RuntimeProfile = "static" | "fetch-js";
/** Who can open an app besides the communities it is shared with. */
export type Audience = "workspace" | "only_you";
const VISIBILITY: Record<Audience, string> = {
  workspace: "organization",
  only_you: "restricted",
};
export const SIGN_IN =
  "Ask your owner to sign in at Settings → Plugins → Builderlab, then try again.";
/** A 401 refuses only the call unless native ends the session, so a signed-in
 * owner may have no sign-in to do. */
const REFUSED =
  "Try again. If it keeps happening, ask your owner to check their Builderlab sign-in at Settings → Plugins → Builderlab.";

type Json = Record<string, unknown>;
const object = (value: unknown): Json =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : {};
const text = (value: unknown) =>
  typeof value === "string" && value ? value : undefined;

export type AppsClient = ReturnType<typeof createAppsClient>;
type Transport = Pick<Host, "request" | "upload">;

/**
 * Apps calls over the native NIP-FI session: native sends its token to the
 * server's control plane as `BBIdentity`, so the renderer never holds it, and
 * refuses a call started under another account.
 */
export function federatedTransport(
  identity: Pick<FederatedIdentity, "request">,
  base: string,
): Transport {
  const path = (url: string) => {
    if (!url.startsWith(`${base}/`))
      throw new Error("Apps calls go to this server's control plane");
    return url.slice(base.length);
  };
  return {
    request: ({ url, method, headers = {}, body, timeoutMs }) =>
      identity.request({
        apps: true,
        path: path(url),
        ...(method ? { method } : {}),
        headers,
        ...(body === undefined ? {} : { body }),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      }),
    upload: ({ url, headers = {}, fields, file }) => {
      if (fields && Object.keys(fields).length)
        throw new Error("Apps deploys send only the archive");
      return identity.request({
        apps: true,
        path: path(url),
        method: "POST",
        headers,
        upload: file,
      });
    },
  };
}

export function createAppsClient(
  session: BuilderlabSession,
  base: string,
  /** Sends each call authenticated with the session: the NIP-FI forwarder
   * (`federatedTransport`) or the development broker. */
  http: Transport,
) {
  // One client belongs to one tool operation, including all its HTTP steps.
  let owner: ReturnType<BuilderlabSession["credential"]> | undefined;
  const signedIn = () => {
    if (session.snapshot().status !== "signed-in")
      throw new Error(`Builderlab is not signed in. ${SIGN_IN}`);
    const current = session.credential();
    if (owner && current !== owner)
      throw new Error("Builderlab sign-in changed. Start a new Apps request.");
    owner = current;
  };
  const headers = {
    Accept: "application/json",
    "X-Hotpod-Agent-Client-Version": PROTOCOL,
  };
  /** The JSON object a call answered, or the error the agent can act on. */
  const answer = (response: HostResponse, what: string) => {
    let body: Json = {};
    try {
      body = object(JSON.parse(response.body));
    } catch {
      // A failure without JSON still reports its status.
    }
    if (response.status === 401)
      throw new Error(
        `Builderlab refused the sign-in for ${what} (HTTP ${response.status}). ${REFUSED}`,
      );
    if (response.status < 200 || response.status >= 300) {
      const error = object(body.error);
      const detail = [
        text(error.code),
        text(error.message) ?? text(body.message),
        text(body.next_action) && `next_action: ${body.next_action}`,
      ]
        .filter(Boolean)
        .join(": ");
      throw new Error(
        `${what} failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`,
      );
    }
    return body;
  };
  const call = async (
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    what: string,
    body?: Json,
  ): Promise<Json> => {
    signedIn();
    const response = await http.request({
      url: `${base}${path}`,
      method,
      headers: {
        ...headers,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      ...(path.endsWith("/initialize") ? { timeoutMs: 180_000 } : {}),
    });
    signedIn();
    return answer(response, what);
  };
  const app = (id: string, resource = "") =>
    `/v1/agent/apps/${encodeURIComponent(id)}${resource && `/${resource}`}`;
  const contract = async () => {
    const result = await call("GET", "/v1/agent/contract", "Reading contract");
    const minimum = text(result.minimum_client_version);
    if (!minimum || !/^\d+\.\d+\.\d+$/.test(minimum))
      throw new Error("Apps Platform returned no valid minimum_client_version");
    const current = PROTOCOL.split(".").map(Number);
    const required = minimum.split(".").map(Number);
    const difference = current
      .map((part, i) => part - (required[i] ?? 0))
      .find((part) => part !== 0);
    if (difference !== undefined && difference < 0)
      throw new Error(
        `Apps Platform requires client ${minimum}; update Buzz before creating or deploying apps`,
      );
    return result;
  };

  return {
    contract,
    list: () => call("GET", "/v1/agent/apps?scope=owned", "Listing apps"),
    /** Plans and reserves the exact runtime advertised by this tenant. */
    async create(name: string, profile: RuntimeProfile = "static") {
      signedIn();
      const info = object((await contract()).runtime_info);
      const profiles = info.supported_runtime_profiles;
      if (
        !Array.isArray(profiles) ||
        !profiles.some((item) => object(item).profile === profile)
      )
        throw new Error(
          `This Apps Platform does not advertise ${profile}; read apps_contract and select a supported runtime`,
        );
      const plan = await call("POST", "/v1/agent/apps/plan", "Planning", {
        name,
        runtime_profile: profile,
        client_version: PROTOCOL,
      });
      const id = text(plan.app_id);
      if (!id) throw new Error("Apps Platform planned no app_id");
      // Older servers omit runtime_profile in the plan. Repeat our explicit
      // choice rather than letting reserve pick an executable default.
      if (text(plan.runtime_profile) && plan.runtime_profile !== profile)
        throw new Error(
          "Apps Platform planned a different runtime; no app was reserved",
        );
      const initialize = object(plan.initialize);
      if (
        typeof initialize.required !== "boolean" ||
        typeof initialize.recommended !== "boolean"
      )
        throw new Error(
          "Apps Platform returned no complete initialization decision; no app was reserved",
        );
      // The reservation repeats what the plan settled.
      const request: Json = { runtime_profile: profile };
      for (const field of ["environment", "persistence", "runtime_class"])
        if (text(plan[field])) request[field] = plan[field];
      if (text(plan.display_name)) request.name = plan.display_name;
      let step = "reserve";
      try {
        const reserved = await call(
          "POST",
          app(id, "reserve"),
          "Reserving",
          request,
        );
        if (reserved.app_id !== id)
          throw new Error(
            `Apps Platform reserved ${String(reserved.app_id)}, not the planned ${id}`,
          );
        step = "initialize";
        const initialized =
          initialize.required === true || initialize.recommended === true
            ? await call("POST", app(id, "initialize"), "Initializing", request)
            : undefined;
        if (initialized && initialized.app_id !== id)
          throw new Error("Apps Platform initialized a different app_id");
        return {
          app_id: id,
          external_url:
            text(initialized?.external_url) ??
            text(reserved.external_url) ??
            text(plan.external_url),
        };
      } catch (error) {
        const detail =
          error instanceof Error ? error.message : "Request failed";
        throw new Error(
          `Create stopped during ${step} for app_id=${id}: ${detail}. The reservation may already exist; inspect or resume this exact app before creating a replacement.`,
        );
      }
    },
    /** Uploads `artifact` as the app's next version. */
    async deploy(id: string, artifact: string) {
      if (!http.upload) throw new Error("Deploying needs the Buzz desktop app");
      signedIn();
      const response = await http.upload({
        url: `${base}${app(id, "deploy")}`,
        headers,
        file: {
          field: "artifact",
          path: artifact,
          name: "artifact.tar.gz",
          contentType: "application/gzip",
        },
      });
      // An accepted upload still returns its IDs after sign-out/account switch.
      // The next readiness request checks the operation's original sign-in.
      return answer(response, "Deploying");
    },
    ready: (
      id: string,
      version: string,
      deployment?: string,
      rollout?: string,
    ) =>
      call(
        "GET",
        `${app(id, "ready")}?${new URLSearchParams({ version_id: version, ...(deployment ? { deployment_id: deployment } : {}), ...(rollout ? { rollout_id: rollout } : {}) })}`,
        "Checking readiness",
      ),
    /** Switches who can open the app, as `bl apps visibility` does. Viewers
     * and community grants are kept. */
    async visibility(id: string, audience: Audience) {
      const visibility = VISIBILITY[audience];
      const updated = await call(
        "PUT",
        app(id, "visibility"),
        "Changing visibility",
        {
          visibility,
        },
      );
      if (updated.app_id !== id || updated.visibility !== visibility)
        throw new Error(
          `Apps Platform reported ${String(updated.app_id)} as ${String(updated.visibility)}, not ${id} as ${visibility}. Ask your owner to check who can open it in Share & manage before retrying`,
        );
      return updated;
    },
    /** Shares the app with a Buzz community or stops sharing it, as `bl apps
     * community` does, at the grant revision it just read. */
    async community(id: string, community: string, action: "grant" | "revoke") {
      const path = app(
        id,
        `sharing/communities/${encodeURIComponent(community)}`,
      );
      const unprepared = new Error(
        "This app isn't set up for sharing yet. Deploy it with apps_deploy, then try again.",
      );
      // Compose answers this read with 409 only when the app has no sharing
      // lifecycle yet. Reservation sets one, and a deploy sets it on older apps.
      const current = await call(
        "GET",
        path,
        "Reading community sharing",
      ).catch((error: unknown) => {
        throw error instanceof Error && error.message.includes("(HTTP 409)")
          ? unprepared
          : error;
      });
      const lifecycle = text(current.lifecycle_id);
      const revision = current.community_grant_revision;
      if (
        !lifecycle ||
        typeof revision !== "number" ||
        !Number.isInteger(revision) ||
        revision < 0
      )
        throw new Error(
          "Apps Platform returned no valid sharing revision for this app; nothing was changed",
        );
      return call(
        action === "grant" ? "POST" : "DELETE",
        path,
        action === "grant"
          ? "Sharing with the community"
          : "Revoking the community",
        { lifecycle_id: lifecycle, expected_revision: revision },
      );
    },
  };
}
