import { transientStatus } from "../../../features/relay/errors";
import { terminalOutcome } from "../../../features/agents/observer";
import { retryRead } from "../../../features/relay/read-retry";
import { invoke } from "@tauri-apps/api/core";
import { nativeIdentityEnabled } from "../../../features/identity/service";
import type {
  HostResponse,
  NipOaAuthorization,
} from "../../../features/host/service";
import { oauthTarget } from "../oauth/browser";
import type { BuilderlabSession, Credential } from "../session";
import {
  clearRegistration,
  registrationIntent,
  type RegistrationIntent,
} from "./registration";

export type RemoteAgent = Readonly<{
  id: string;
  name: string;
  pubkey: string;
  status: "Active" | "Unattested" | "Revoked" | "Unknown";
  instructions?: string;
  modelId?: string;
  reasoningEffort?: string;
  modelSelectionStatus?:
    | "valid"
    | "setup-required"
    | "model-unavailable"
    | "effort-unsupported"
    | "unknown";
}>;

export type RemoteAgentModel = Readonly<{
  id: string;
  displayName: string;
  supportedReasoningEfforts: readonly string[];
  /** Served on low-latency inference hardware, such as Cerebras. */
  fast?: boolean;
}>;

export type RemoteAgentModelCatalog = Readonly<{
  models: readonly RemoteAgentModel[];
  /** Builderlab's creation default; present only when the catalog offers it. */
  recommended?: Readonly<{ modelId: string; reasoningEffort: string }>;
}>;

function modelSelectionStatus(
  value: unknown,
): NonNullable<RemoteAgent["modelSelectionStatus"]> {
  switch (value) {
    case 1:
    case "MODEL_SELECTION_STATUS_VALID":
      return "valid";
    case 2:
    case "MODEL_SELECTION_STATUS_SETUP_REQUIRED":
      return "setup-required";
    case 3:
    case "MODEL_SELECTION_STATUS_MODEL_UNAVAILABLE":
      return "model-unavailable";
    case 4:
    case "MODEL_SELECTION_STATUS_EFFORT_UNSUPPORTED":
      return "effort-unsupported";
    default:
      return "unknown";
  }
}

export const MAX_INSTRUCTIONS_LENGTH = 20_000;
const AGENT_NAME = /^[\w .-]{1,64}$/;
const INVALID_NAME =
  "Use 1–64 letters, numbers, spaces, dots, hyphens or underscores for the agent name.";

export function validInstructions(value: unknown): value is string {
  return (
    typeof value === "string" &&
    (value === "" || !!value.trim()) &&
    value.length <= MAX_INSTRUCTIONS_LENGTH
  );
}

function resultStatus(value: unknown) {
  return typeof value === "string"
    ? (value.split("_").at(-1) ?? "")
    : typeof value === "number"
      ? value
      : "";
}

function agentStatus(value: unknown): RemoteAgent["status"] {
  const status = String(value ?? "")
    .split("_")
    .at(-1);
  if (status === "2" || status === "ACTIVE") return "Active";
  if (status === "1" || status === "UNATTESTED") return "Unattested";
  if (status === "3" || status === "REVOKED") return "Revoked";
  return "Unknown";
}

/** Native owner identity: the viewer key and the Builderlab-binding-only signer. */
export type OwnerIdentity = Readonly<{
  key(): Promise<string | null>;
  signBinding(challenge: Record<string, unknown>): Promise<object>;
}>;
const nativeOwner: OwnerIdentity = {
  key: () => invoke("identity_restore"),
  signBinding: (challenge) =>
    invoke("identity_sign_builderlab_binding", { challenge }),
};

class BuilderlabUnavailable extends Error {}

export function isRetryableAgentRead(error: unknown): boolean {
  return (
    error instanceof BuilderlabUnavailable ||
    (error instanceof Error &&
      "status" in error &&
      typeof error.status === "number" &&
      transientStatus(error.status))
  );
}

const LINK_ERRORS: Record<string, string> = {
  identity_already_bound:
    "This Builderlab account is linked to a different Buzz identity.",
  pubkey_already_bound:
    "This Buzz identity is linked to a different Builderlab account.",
};

export function createAgentClient(
  session: BuilderlabSession,
  // Without native identity (the dev viewer), owner proofs come from the
  // dev broker, which has no binding signer, so linking is skipped.
  owner: OwnerIdentity | null = nativeIdentityEnabled() ? nativeOwner : null,
) {
  /** The sign-in's credential, once its permissions are fresh and allow
   * remote agents. Stop is urgent: it acts on the permissions already known. */
  async function remoteCredential(signal: AbortSignal, urgent = false) {
    const credential = urgent
      ? session.credential()
      : await session.freshCredential(signal);
    if (!credential.account.canUseRemoteAgents)
      throw new Error(
        "Builderlab remote agents are unavailable for this account.",
      );
    return credential;
  }
  function check(credential: Credential, signal: AbortSignal) {
    signal.throwIfAborted();
    if (
      session.snapshot().status !== "signed-in" ||
      session.credential() !== credential
    )
      throw new DOMException("Builderlab session changed.", "AbortError");
  }
  function refuseExpired(response: HostResponse) {
    if (response.status !== 401) return;
    throw Object.assign(
      new Error("Your Builderlab session expired. Sign in again."),
      { status: 401 },
    );
  }
  async function request(
    path: string,
    body: unknown,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    signal.throwIfAborted();
    const credential = await remoteCredential(
      signal,
      path === "cancel-agent-turn",
    );
    let response: HostResponse;
    try {
      response = await session.request(credential, {
        path: `/v3/beekeeper/${path}`,
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    } catch {
      check(credential, signal);
      throw new BuilderlabUnavailable("Could not reach Builderlab. Try again.");
    }
    check(credential, signal);
    refuseExpired(response);
    if (response.status === 403)
      throw Object.assign(
        new Error("This Builderlab account cannot manage remote agents."),
        { status: 403 },
      );
    if (response.status < 200 || response.status >= 300)
      throw Object.assign(
        new Error(`Builderlab request failed (HTTP ${response.status}).`),
        { status: response.status },
      );
    try {
      const result = JSON.parse(response.body);
      if (!result || typeof result !== "object" || Array.isArray(result))
        throw new Error();
      return result;
    } catch {
      throw new Error("Builderlab returned an invalid response.");
    }
  }
  function readRequest(
    path: "get-model-catalog" | "list-agents" | "get-agent-turn-status",
    body: unknown,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    const credential = session.credential();
    return retryRead(
      (signal) => {
        check(credential, signal);
        return request(path, body, signal);
      },
      signal,
      isRetryableAgentRead,
    );
  }
  /** Builderlab's identity routes answer failures with `{ error: { code } }`. */
  async function identityRequest(
    path: string,
    body: object,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    signal.throwIfAborted();
    const credential = session.credential();
    const target = oauthTarget();
    let response: HostResponse;
    try {
      response = await session.request(credential, {
        path: `/v1/buzz/nostr-identities/${path}`,
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          // Binding requires the challenge origin to match this header.
          Origin: new URL(target).origin,
        },
        body: JSON.stringify(body),
      });
    } catch {
      check(credential, signal);
      throw new Error("Could not reach Builderlab. Try again.");
    }
    check(credential, signal);
    refuseExpired(response);
    let result: Record<string, unknown> | undefined;
    try {
      const parsed = JSON.parse(response.body);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        result = parsed;
    } catch {
      // Reported below with the HTTP status.
    }
    const error = result?.error as
      | { code?: unknown; setup_needed?: unknown }
      | undefined;
    // An unbound account reports the missing mapping as setup needed.
    if (path === "current" && error?.setup_needed === true) return {};
    const code = error?.code;
    if (response.status >= 200 && response.status < 300 && result && !code)
      return result;
    if (typeof code === "string" && Object.hasOwn(LINK_ERRORS, code))
      throw new Error(LINK_ERRORS[code]);
    throw new Error(
      `Could not link your Buzz identity to Builderlab (${
        typeof code === "string" ? code : `HTTP ${response.status}`
      }).`,
    );
  }
  const boundKey = (result: Record<string, unknown>) => {
    const hex = (result.identity as { pubkey_hex?: unknown } | undefined)
      ?.pubkey_hex;
    return typeof hex === "string" ? hex.toLowerCase() : null;
  };
  // Sign-in and the activation guard can overlap; they share one binding attempt.
  let linking: { credential: Credential; done: Promise<void> } | undefined;
  /** Binds this device's Buzz key to the signed-in account; attestation requires it. */
  function link(signal: AbortSignal): Promise<void> {
    if (!owner) return Promise.resolve();
    const credential = session.credential();
    if (linking?.credential !== credential) {
      const done = bind(owner, signal).finally(() => {
        if (linking?.done === done) linking = undefined;
      });
      linking = { credential, done };
    }
    return linking.done;
  }
  async function bind(
    owner: OwnerIdentity,
    signal: AbortSignal,
  ): Promise<void> {
    const key = await owner.key().catch(() => null);
    signal.throwIfAborted();
    if (typeof key !== "string" || !/^[0-9a-f]{64}$/.test(key))
      throw new Error("Set up your Buzz identity before creating an agent.");
    const credential = session.credential();
    const bound = boundKey(await identityRequest("current", {}, signal));
    if (bound === key) {
      backupLinkedIdentity();
      return;
    }
    // Never replace another key's binding; unlinking is the account owner's choice.
    if (bound) throw new Error(LINK_ERRORS.identity_already_bound);
    const challenge = await identityRequest(
      "challenge",
      { origin: new URL(oauthTarget()).origin },
      signal,
    );
    const { challenge_id, nonce, verification_code, origin, expires_at } =
      challenge;
    let event: object;
    try {
      event = await owner.signBinding({
        challenge_id,
        nonce,
        verification_code,
        origin,
        expires_at,
      });
    } catch (error) {
      throw typeof error === "string" ? new Error(error) : error;
    }
    // A new sign-in while signing must not let the old account claim this key.
    check(credential, signal);
    const verified = await identityRequest(
      "verify",
      { challenge_id, nonce, signed_payload: JSON.stringify(event) },
      signal,
    );
    if (boundKey(verified) !== key)
      throw new Error("Builderlab did not confirm your Buzz identity link.");
    backupLinkedIdentity();
  }
  function backupLinkedIdentity() {
    if (nativeIdentityEnabled())
      void invoke("nsec_backup_retry").catch(() => {});
  }
  async function activate(
    pubkey: string,
    auth: NipOaAuthorization,
    community: string | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    await link(signal);
    const result = await request(
      "attest-agent",
      {
        agent_pubkey: pubkey,
        owner_auth_tag_json: JSON.stringify(auth),
        ...(community ? { community_url: community } : {}),
      },
      signal,
    );
    if (![1, "ACTIVE"].includes(resultStatus(result.status)))
      throw new Error(
        `Agent setup was not confirmed (${
          typeof result.status === "string" || typeof result.status === "number"
            ? result.status
            : "no status"
        }). Retry setup in Agents.`,
      );
  }
  return {
    /** Reads only terminal outcomes for exact tasks in the owner's agent session. */
    async turnStatus(
      sessionId: string,
      taskIds: readonly string[],
      signal: AbortSignal,
    ) {
      const result = await readRequest(
        "get-agent-turn-status",
        {
          session_id: sessionId,
          task_ids: taskIds,
        },
        signal,
      );
      const outcomes = result.outcomes;
      if (!outcomes || typeof outcomes !== "object" || Array.isArray(outcomes))
        throw new Error("Builderlab returned invalid turn status.");
      const statuses = new Map<string, "ended" | "error" | "stopped">();
      for (const [taskId, value] of Object.entries(outcomes)) {
        const outcome = terminalOutcome("turn_completed", value);
        if (
          !taskIds.includes(taskId) ||
          !outcome ||
          outcome === "unknown" ||
          value === undefined
        )
          throw new Error("Builderlab returned invalid turn status.");
        statuses.set(taskId, outcome);
      }
      return statuses;
    },
    link,
    activate,
    async modelCatalog(signal: AbortSignal): Promise<RemoteAgentModelCatalog> {
      const result = await readRequest("get-model-catalog", {}, signal);
      const models = result.models ?? [];
      if (
        !Array.isArray(models) ||
        models.some(
          (model) =>
            !model ||
            typeof model.id !== "string" ||
            !model.id.trim() ||
            typeof model.display_name !== "string" ||
            !model.display_name.trim() ||
            !Array.isArray(model.supported_reasoning_efforts) ||
            !model.supported_reasoning_efforts.length ||
            model.supported_reasoning_efforts.some(
              (effort: unknown) => typeof effort !== "string" || !effort.trim(),
            ),
        )
      )
        throw new Error("Builderlab returned an invalid model catalog.");
      const { model_id: modelId, reasoning_effort: reasoningEffort } =
        (result.recommended_selection ?? {}) as Record<string, unknown>;
      const recommended = models.find((model) => model.id === modelId);
      return {
        models: models.map((model) => ({
          id: model.id,
          displayName: model.display_name,
          supportedReasoningEfforts: model.supported_reasoning_efforts,
          fast: model.fast === true,
        })),
        // Advisory: an unknown or unsupported pair is dropped, never an error.
        ...(typeof reasoningEffort === "string" &&
        recommended?.supported_reasoning_efforts.includes(reasoningEffort)
          ? { recommended: { modelId: recommended.id, reasoningEffort } }
          : {}),
      };
    },
    async updateModel(
      agent: RemoteAgent,
      modelId: string,
      reasoningEffort: string,
      signal: AbortSignal,
    ): Promise<void> {
      if (agent.status !== "Active" || !/^[0-9a-f]{64}$/.test(agent.pubkey))
        throw new Error("Only Active agents can have their model edited.");
      if (!modelId.trim() || !reasoningEffort.trim())
        throw new Error("Choose a model and reasoning effort.");
      await request(
        "update-agent",
        {
          agent_pubkey: agent.pubkey,
          model_id: modelId,
          reasoning_effort: reasoningEffort,
        },
        signal,
      );
    },
    async configure(
      pubkey: string,
      settings: {
        instructions: string;
        modelId: string;
        reasoningEffort: string;
      },
      signal: AbortSignal,
    ): Promise<void> {
      if (
        !/^[0-9a-f]{64}$/.test(pubkey) ||
        !validInstructions(settings.instructions) ||
        !settings.modelId.trim() ||
        !settings.reasoningEffort.trim()
      )
        throw new Error(
          "Choose a model and reasoning effort and check the instructions.",
        );
      await request(
        "update-agent",
        {
          agent_pubkey: pubkey,
          agent_instructions: settings.instructions,
          model_id: settings.modelId,
          reasoning_effort: settings.reasoningEffort,
        },
        signal,
      );
    },
    async updateInstructions(
      agent: RemoteAgent,
      instructions: string,
      signal: AbortSignal,
    ): Promise<void> {
      if (agent.status !== "Active" || !/^[0-9a-f]{64}$/.test(agent.pubkey))
        throw new Error(
          "Only Active agents can have their instructions edited.",
        );
      if (!validInstructions(instructions))
        throw new Error(
          `Instructions must be empty or contain up to ${MAX_INSTRUCTIONS_LENGTH} characters of nonblank text.`,
        );
      await request(
        "update-agent",
        { agent_pubkey: agent.pubkey, agent_instructions: instructions },
        signal,
      );
    },
    /** Republishes the agent's profile; Beekeeper keeps the stored picture when none is sent. */
    async updateProfile(
      profile: Readonly<{
        pubkey: string;
        community: string;
        name: string;
        picture?: string;
      }>,
      signal: AbortSignal,
    ): Promise<void> {
      const agentName = profile.name.trim();
      if (!AGENT_NAME.test(agentName)) throw new Error(INVALID_NAME);
      await request(
        "update-agent-profile",
        {
          agent_pubkey: profile.pubkey,
          community_url: profile.community,
          agent_name: agentName,
          agent_picture_url: profile.picture ?? "",
        },
        signal,
      );
    },
    async delete(
      agent: Pick<RemoteAgent, "id">,
      signal: AbortSignal,
    ): Promise<void> {
      if (!agent.id.trim()) throw new Error("Agent ID is unavailable.");
      const result = await request(
        "delete-agent",
        { agent_id: agent.id },
        signal,
      );
      const status = resultStatus(result.status);
      // NOT_FOUND also confirms completion after a successful delete lost its response.
      if ([1, "DELETED", 3, "FOUND"].includes(status)) return;
      throw new Error(
        [2, "DISABLED"].includes(status)
          ? "Agent deletion is disabled on this server."
          : "Agent deletion was not confirmed. Retry Delete.",
      );
    },
    /** Stops the agent's turn in one conversation. False when nothing there
     * was running. */
    async cancelTurn(
      agent: Pick<RemoteAgent, "id">,
      place: Readonly<{
        community: string;
        channelId: string;
        threadRootId: string;
      }>,
      signal: AbortSignal,
    ): Promise<boolean> {
      const result = await request(
        "cancel-agent-turn",
        {
          agent_id: agent.id,
          // Beekeeper keys conversations by the community's host.
          community: new URL(place.community).host,
          channel_id: place.channelId,
          thread_root_event_id: place.threadRootId,
        },
        signal,
      );
      const status = resultStatus(result.status);
      if ([1, "CANCELLING"].includes(status)) return true;
      if ([2, "RUNNING", 3, "FOUND"].includes(status)) return false;
      throw new Error(
        typeof result.message === "string" && result.message
          ? result.message
          : "Builderlab did not stop the agent. Try again.",
      );
    },
    async register(
      name: string,
      signal: AbortSignal,
      /** Retains the provisioned identity and owns completion of its replay
       * intent. A throw leaves the UUID available for retry. */
      retainRegistration: (
        agent: RemoteAgent,
        intent: RegistrationIntent,
      ) => void,
      picture?: string,
    ): Promise<RemoteAgent & Readonly<{ picture?: string }>> {
      signal.throwIfAborted();
      const agentName = name.trim();
      if (!AGENT_NAME.test(agentName)) throw new Error(INVALID_NAME);
      const credential = await remoteCredential(signal);
      const { account } = credential;
      const intent = registrationIntent(
        oauthTarget(),
        account.subject,
        agentName,
        picture,
      );
      let result: Record<string, unknown>;
      try {
        result = await request(
          "register-agent",
          {
            agent_name: agentName,
            ...(intent.picture ? { agent_picture_url: intent.picture } : {}),
            idempotency_key: intent.key,
          },
          signal,
        );
      } catch (error) {
        if (
          error instanceof Error &&
          "status" in error &&
          [400, 401, 403, 404, 409, 422].includes(Number(error.status))
        ) {
          clearRegistration(intent);
        } else if (error instanceof Error && error.name !== "AbortError") {
          throw new Error(
            `${error.message} Retry the same name to recover the original request.`,
          );
        }
        throw error;
      }
      const status = resultStatus(result.status);
      const rejected = new Map<string | number, string>([
        [2, "Agent creation is disabled on this server."],
        ["DISABLED", "Agent creation is disabled on this server."],
        [3, "Finish setup for an existing agent before creating another."],
        [
          "REGISTRATIONS",
          "Finish setup for an existing agent before creating another.",
        ],
        [4, "Your remote agent limit has been reached."],
        ["AGENTS", "Your remote agent limit has been reached."],
        [5, "This creation request conflicts with another agent name."],
        [
          "CONFLICT",
          "This creation request conflicts with another agent name.",
        ],
      ]).get(status);
      if (rejected) {
        clearRegistration(intent);
        throw new Error(rejected);
      }
      if (
        ![1, "UNATTESTED"].includes(status) ||
        typeof result.agent_id !== "string" ||
        !result.agent_id.trim() ||
        typeof result.agent_pubkey !== "string" ||
        !/^[0-9a-f]{64}$/.test(result.agent_pubkey)
      )
        throw new Error(
          "Creation was not confirmed. Retry the same name to recover the original request.",
        );
      const agent: RemoteAgent = {
        id: result.agent_id,
        name: agentName,
        pubkey: result.agent_pubkey,
        status: "Unattested",
      };
      // Hosted provisioning keeps replay until Agents has durably saved setup.
      check(credential, signal);
      retainRegistration(agent, intent);
      // A replay registers the first picture, not the one passed this time.
      return {
        ...agent,
        ...(intent.picture ? { picture: intent.picture } : {}),
      };
    },
    async list(signal: AbortSignal): Promise<readonly RemoteAgent[]> {
      const result = await readRequest(
        "list-agents",
        { include_instructions: true },
        signal,
      );
      if (![1, "SUCCESS"].includes(resultStatus(result.status)))
        throw new Error("Builderlab did not return an agent list.");
      // Protobuf JSON can omit an empty repeated field.
      const agents = result.agents ?? [];
      if (
        !Array.isArray(agents) ||
        agents.some(
          (row) =>
            !row ||
            typeof row.agent_id !== "string" ||
            !row.agent_id.trim() ||
            typeof row.agent_name !== "string" ||
            typeof row.agent_pubkey !== "string" ||
            !/^[0-9a-f]{64}$/.test(row.agent_pubkey) ||
            (row.agent_instructions !== undefined &&
              !validInstructions(row.agent_instructions)),
        )
      )
        throw new Error("Builderlab returned an invalid agent list.");
      return agents.map((row) => ({
        id: row.agent_id,
        name: row.agent_name,
        pubkey: row.agent_pubkey,
        status: agentStatus(row.status),
        instructions: row.agent_instructions ?? "",
        ...(typeof row.model_id === "string" ? { modelId: row.model_id } : {}),
        ...(typeof row.reasoning_effort === "string"
          ? { reasoningEffort: row.reasoning_effort }
          : {}),
        ...(row.model_selection_status !== undefined
          ? {
              modelSelectionStatus: modelSelectionStatus(
                row.model_selection_status,
              ),
            }
          : {}),
      }));
    },
  };
}
export type AgentClient = ReturnType<typeof createAgentClient>;
