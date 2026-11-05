import { BuilderlabLogoIcon } from "../../../shared/design-system/icons";
import { createActivityTab } from "./Activity";
import { createSettingsTab } from "./Instructions";
import { createProfileActions } from "./SignInFooter";
import {
  creationConfig,
  createCreationAction,
  createCreationFields,
  EMPTY_CREATION,
} from "./Create";
import type { AgentType } from "../../../features/agents/service";
import type { RelayData } from "../../../features/relay/service";
import type { AgentClient } from "../agents/client";
import {
  clearRegistration,
  type RegistrationIntent,
} from "../agents/registration";
import { oauthTarget } from "../oauth/browser";
import type { BuilderlabSession } from "../session";

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
    target: oauthTarget(),
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
    if (value.target !== current.target || value.subject !== current.subject)
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
  async function validateCreation(config: unknown, signal: AbortSignal) {
    await session.ensureSignedIn(signal);
    const catalog = await client.modelCatalog(signal);
    const draft = creationConfig(config);
    if (draft.subject !== session.credential().account.subject)
      throw new Error(
        "Sign in to the Builderlab account that selected these model settings.",
      );
    if (
      !catalog
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
      async provision({ name, picture, config, signal }) {
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
      },
      async activate({ pubkey, auth, community, config, signal }) {
        await session.ensureSignedIn(signal);
        const saved = identity(pubkey);
        const draft =
          config === undefined
            ? undefined
            : await validateCreation(config, signal);
        // Agents persisted unfinished setup before invoking activation. Until
        // here, a failed setup write must still replay the original provision.
        if (saved?.registration) clearRegistration(saved.registration);
        await client.activate(pubkey, auth, community, signal);
        if (draft) await client.configure(pubkey, draft, signal);
      },
      async profile({ signal, ...profile }) {
        await session.ensureSignedIn(signal);
        await client.updateProfile(profile, signal);
      },
      async interrupt({ pubkey, signal, ...place }) {
        // A stop is urgent: it never waits on an interactive sign-in.
        session.credential();
        return client.cancelTurn(await resolve(pubkey, signal), place, signal);
      },
      async remove({ pubkey, signal }) {
        await session.ensureSignedIn(signal);
        const saved = await resolve(pubkey, signal);
        await client.delete(saved, signal);
        if (saved.registration) clearRegistration(saved.registration);
      },
    },
  };
}
