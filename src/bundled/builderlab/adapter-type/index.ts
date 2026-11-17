import { BuilderlabLogoIcon } from "../../../shared/design-system/icons";
import { createActivityTab } from "./Activity";
import { createSettingsTab } from "./Instructions";
import { createProfileActions } from "./SignInFooter";
import {
  creationConfig,
  createCreationAction,
  createCreationFields,
  EMPTY_CREATION,
  type CreationConfig,
} from "./Create";
import type { AgentType } from "../../../features/agents/service";
import type { RelayData } from "../../../features/relay/service";
import type { AgentClient } from "../agents/client";
import {
  clearRegistration,
  type RegistrationIntent,
} from "../agents/registration";
import { sessionTarget, type BuilderlabSession } from "../session";

const PREFIX = "buzz.builderlab.adapter-identity.v1:";
type Identity = {
  target: string;
  subject: string;
  id: string;
  registration?: RegistrationIntent;
};

/** Bridge Agents' lifecycle and provider settings to Beekeeper. */
export function builderlabType(
  client: AgentClient,
  session: BuilderlabSession,
  relay: RelayData,
  openIdentity?: () => void,
  openSettings?: (section: string) => void,
): AgentType {
  const scope = () => ({
    target: sessionTarget(session),
    subject: session.credential().account.subject,
  });
  function remember(
    pubkey: string,
    id: string,
    registration?: RegistrationIntent,
  ) {
    // Retain the backend ID for delete replay, including after backend removal.
    // This contains neither a credential nor an owner proof.
    const saved: Identity = { ...scope(), id };
    if (registration) saved.registration = registration;
    localStorage.setItem(PREFIX + pubkey, JSON.stringify(saved));
    return saved;
  }
  function identity(pubkey: string): Identity | undefined {
    const saved = localStorage.getItem(PREFIX + pubkey);
    if (saved === null) return undefined;
    const value: Identity = JSON.parse(saved);
    if (
      !value ||
      typeof value.target !== "string" ||
      typeof value.subject !== "string" ||
      typeof value.id !== "string" ||
      !value.id.trim()
    )
      throw new Error("Saved Builderlab agent identity is invalid.");
    const current = scope();
    // Another server's agent is managed only from one of its communities.
    if (value.target !== current.target)
      throw new Error(
        "This agent is on another Builderlab server. Open one of its communities to manage it.",
      );
    if (value.subject !== current.subject)
      throw new Error(
        "Sign in to the Builderlab account that created this agent.",
      );
    return value;
  }
  /** The agent's saved identity, else the signed-in account's listing of it. */
  async function resolve(pubkey: string, signal: AbortSignal) {
    const saved = identity(pubkey);
    if (saved) return saved;
    const credential = session.credential();
    const agent = (await client.list(signal)).find(
      (row) => row.pubkey === pubkey,
    );
    if (session.credential() !== credential)
      throw new DOMException("Builderlab session changed.", "AbortError");
    if (!agent) throw new Error("Agent not found in this Builderlab account.");
    return remember(pubkey, agent.id);
  }
  /** The signed-in account's listing of the agent, with its instructions.
   * It never starts browser login: only the pane's Sign in does, so a tab
   * that reads instructions when it opens asks the owner to sign in first. */
  async function listed(pubkey: string, signal: AbortSignal) {
    const credential = session.credential();
    const agent = (await client.list(signal)).find(
      (row) => row.pubkey === pubkey,
    );
    if (session.credential() !== credential)
      throw new DOMException("Builderlab session changed.", "AbortError");
    if (!agent) throw new Error("Agent not found in this Builderlab account.");
    return agent;
  }
  /** Runs an operation on the server it started on: a selection that moves
   * the session to another server aborts it before its next request. */
  async function pinned<T>(
    signal: AbortSignal,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const target = sessionTarget(session);
    const moved = new AbortController();
    const stop = session.subscribe(() => {
      if (sessionTarget(session) !== target)
        moved.abort(
          new Error(
            "The selected community uses another Builderlab server. Try again from this agent's community.",
          ),
        );
    });
    try {
      return await run(AbortSignal.any([signal, moved.signal]));
    } finally {
      stop();
    }
  }
  async function validateCreation(config: unknown, signal: AbortSignal) {
    await session.ensureSignedIn(signal);
    const catalog = await client.modelCatalog(signal);
    const draft = creationConfig(config);
    if (draft.subject !== session.credential().account.subject)
      throw new Error(
        "Sign in to the Builderlab account that selected these model settings.",
      );
    if (
      !catalog.models
        .find((model) => model.id === draft.modelId)
        ?.supportedReasoningEfforts.includes(draft.reasoningEffort)
    )
      throw new Error(
        "Choose a model and thinking level offered in the model catalog.",
      );
    return draft;
  }
  return {
    id: "builderlab",
    title: "Builderlab",
    icon: BuilderlabLogoIcon,
    description: "Sign in to Builderlab when creating an agent.",
    defaults: () => ({ config: { ...EMPTY_CREATION } }),
    // Instructions brought to a new agent, as from an agent card.
    adopt: (carry, saved) => ({
      ...(saved as CreationConfig),
      instructions:
        carry.instructions ?? (saved as CreationConfig).instructions,
    }),
    ...createCreationFields(client, session),
    CreateAction: createCreationAction(session),
    ProfileActions: createProfileActions(session),
    tabs: [
      {
        id: "settings",
        title: "Settings",
        role: "settings",
        splitSettings: true,
        component: createSettingsTab(client, session, openIdentity),
      },
      {
        id: "activity",
        title: "Activity",
        role: "activity",
        component: createActivityTab(relay, openSettings),
      },
    ],
    remote: {
      provision: ({ name, picture, config, signal }) =>
        pinned(signal, async (signal) => {
          await validateCreation(config, signal);
          const agent = await client.register(
            name,
            signal,
            ({ pubkey, id }, intent) => remember(pubkey, id, intent),
            picture,
          );
          return {
            pubkey: agent.pubkey,
            ...(agent.picture ? { picture: agent.picture } : {}),
          };
        }),
      activate: ({ pubkey, auth, community, config, signal }) =>
        pinned(signal, async (signal) => {
          await session.ensureSignedIn(signal);
          const saved = identity(pubkey);
          const draft =
            config === undefined
              ? undefined
              : await validateCreation(config, signal);
          // Agents persisted unfinished setup before invoking activation.
          // Until here, a failed setup write must still replay the original
          // provision.
          if (saved?.registration) clearRegistration(saved.registration);
          await client.activate(pubkey, auth, community, signal);
          if (draft) await client.configure(pubkey, draft, signal);
        }),
      profile: ({ signal, ...profile }) =>
        pinned(signal, async (signal) => {
          await session.ensureSignedIn(signal);
          await client.updateProfile(profile, signal);
        }),
      interrupt: ({ pubkey, signal, ...place }) =>
        pinned(signal, async (signal) => {
          // A stop is urgent: it never waits on an interactive sign-in.
          session.credential();
          return client.cancelTurn(
            await resolve(pubkey, signal),
            place,
            signal,
          );
        }),
      instructions: {
        get: ({ pubkey, signal }) =>
          pinned(
            signal,
            async (signal) => (await listed(pubkey, signal)).instructions ?? "",
          ),
        set: ({ pubkey, instructions, signal }) =>
          pinned(signal, async (signal) => {
            await client.updateInstructions(
              await listed(pubkey, signal),
              instructions,
              signal,
            );
          }),
      },
      remove: ({ pubkey, signal }) =>
        pinned(signal, async (signal) => {
          await session.ensureSignedIn(signal);
          const saved = await resolve(pubkey, signal);
          await client.delete(saved, signal);
          if (saved.registration) clearRegistration(saved.registration);
        }),
    },
  };
}
