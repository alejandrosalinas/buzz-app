import type { Agent, Agents } from "../../features/agents/service";
import { randomAgentAvatar } from "../../features/agents/avatar-packs";
import type { RelayData, RelaySnapshot } from "../../features/relay/service";
import type { Builderlab } from "../builderlab/service";
import {
  MAX_INSTRUCTIONS_LENGTH,
  type RemoteAgentModel,
} from "../builderlab/agents/client";
import { bestieInstructions, promptVersion } from "./prompt";

/** The Builderlab hosted type's Agents key, `pluginId/typeId`. */
export const BUILDERLAB_TYPE = "block.builderlab/builderlab";
export const NAME = "Bestie";

type Record = {
  version: 1;
  owner: string;
  /** Reserved before anything else, so every retry reuses one home. */
  channelId: string;
  agent?: string | undefined;
  channelOperation?: string | undefined;
  channelFailed?: boolean | undefined;
  promptVersion?: string | undefined;
  welcomeId?: string | undefined;
  welcomeFailed?: boolean | undefined;
  complete?: boolean | undefined;
};
/** The Builderlab model Bestie runs on; Builderlab offers no default. */
export type ModelChoice = Readonly<{
  modelId: string;
  reasoningEffort: string;
}>;
type State = Readonly<{
  status:
    | "unavailable"
    | "idle"
    | "busy"
    | "choose-agent"
    | "choose-model"
    | "ready"
    | "error";
  message: string;
  candidates?: readonly Agent[];
  /** Builderlab's catalog, while the owner chooses Bestie's model. */
  models?: readonly RemoteAgentModel[];
  /** Setup stopped short of making a new Bestie; the owner may ask for one. */
  canCreateNew?: boolean;
  record?: Record | undefined;
  connection?: RelaySnapshot;
  /** A set-up Bestie whose instructions differ from prompt.ts. */
  instructionsChanged?: boolean;
}>;
type SetupOptions = Readonly<{ createNew?: boolean; model?: ModelChoice }>;
/** Setup won't make a Bestie on its own here, but the owner may ask for one. */
class CreateNewError extends Error {}
const HEX = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function read(key: string, owner: string): Record | undefined {
  const raw = localStorage.getItem(key);
  if (!raw) return;
  let record: Record;
  try {
    record = JSON.parse(raw);
  } catch {
    throw new Error(
      "Saved Bestie setup is unreadable. No new agent was created.",
    );
  }
  if (
    record?.version !== 1 ||
    record.owner !== owner ||
    !HEX.test(owner) ||
    !UUID.test(record.channelId) ||
    (record.agent !== undefined && !HEX.test(record.agent)) ||
    (record.complete && (!record.agent || !record.promptVersion)) ||
    [record.channelOperation, record.welcomeId].some(
      (id) => id !== undefined && !HEX.test(id),
    )
  )
    throw new Error(
      "Saved Bestie setup is invalid. Review it before retrying.",
    );
  return record;
}

/** Whether a set-up Bestie's instructions differ from the current prompt. */
function changed(record: Record) {
  return (
    record.promptVersion !==
    promptVersion(bestieInstructions(record.owner, record.channelId))
  );
}

/** Builderlab's gates surface as HTTP statuses on its client errors. */
function explain(error: unknown) {
  const status =
    error instanceof Error && "status" in error ? Number(error.status) : 0;
  // Owner actions need the Buzz or Builderlab capability, which account
  // screening withholds until the owner's details pass.
  if (status === 403)
    return "Builderlab won't let this account run remote agents yet. If Builderlab asks you to finish your account details, complete them there, then retry setup.";
  return error instanceof Error
    ? error.message
    : "Bestie setup failed. Retry to continue.";
}

/** Setup coordinates existing owners: Agents makes and lists Bestie,
 * Builderlab holds its instructions, the session writes the home channel. */
export function createRemoteBestie(
  builderlab: Builderlab,
  agents: Agents,
  relay: RelayData,
) {
  let disposed = false;
  let operation: AbortController | undefined;
  let work: Promise<void> | undefined;
  let state: State = { status: "unavailable", message: "" };
  /** A setup result (error or choice) that only a retry or reconnect clears. */
  let held = false;
  /** The setup request waiting for the owner's model choice. */
  let awaitingModel: { selected?: string; options: SetupOptions } | undefined;
  const listeners = new Set<() => void>();
  const publish = (next: State) => {
    state = next;
    for (const listener of listeners) listener();
  };
  function scope() {
    const connection = relay.snapshot();
    const { viewer, origin } = connection;
    if (connection.status !== "ready" || !viewer || !origin) return;
    return {
      connection,
      owner: viewer,
      key: `buzz.remote-bestie.v2:${JSON.stringify([origin, viewer])}`,
    };
  }
  function refresh() {
    if (disposed || work) return;
    try {
      const current = scope();
      if (!current) {
        publish({
          status: "unavailable",
          message: "Sign in to Buzz and choose a community to set up Bestie.",
        });
        return;
      }
      const inventory = agents.snapshot();
      if (inventory.status !== "ready") {
        publish({
          status: inventory.status === "error" ? "error" : "unavailable",
          message:
            inventory.status === "error"
              ? (inventory.error ?? "Your agents could not be loaded.")
              : "Loading your agents…",
        });
        return;
      }
      const record = read(current.key, current.owner);
      publish({
        status: record?.complete ? "ready" : "idle",
        message: record?.complete
          ? "Your Bestie is set up."
          : "Set up Bestie in this community.",
        record,
        connection: current.connection,
        instructionsChanged: !!record?.complete && changed(record),
      });
    } catch (error) {
      publish({ status: "error", message: explain(error) });
    }
  }
  const stopRelay = relay.subscribe(() => {
    if (relay.snapshot().session !== state.connection?.session) {
      // A new connection invalidates setup in flight; its retry starts afresh.
      operation?.abort();
      held = false;
      awaitingModel = undefined;
    }
    if (!held) refresh();
  });
  const stopAgents = agents.subscribe(() => {
    if (!held) refresh();
  });
  refresh();

  async function provision(
    signal: AbortSignal,
    selected?: string,
    options: SetupOptions = {},
  ) {
    const context = scope();
    if (!context) throw new Error("Connect to a community first.");
    const { key, owner, connection } = context;
    const session = connection.session;
    const active = () =>
      !disposed && !signal.aborted && relay.snapshot().session === session;
    const check = () => {
      signal.throwIfAborted();
      if (!active())
        throw new DOMException("Account or community changed.", "AbortError");
    };
    const saved = read(key, owner);
    const record: Record = saved ?? {
      version: 1,
      owner,
      channelId: crypto.randomUUID(),
    };
    const save = () => localStorage.setItem(key, JSON.stringify(record));
    const progress = (message: string) => {
      check();
      publish({
        status: "busy",
        message,
        record,
        connection,
        // A failure keeps offering the update it interrupted.
        instructionsChanged: !!record.complete && changed(record),
      });
    };
    /** Stops for the owner to choose Bestie's model from Builderlab's
     * catalog; choosing resumes this same request. */
    const askForModel = async (message: string) => {
      const { models } = await builderlab.modelCatalog(signal);
      check();
      if (!models.length)
        throw new Error(
          "Builderlab has no models available for Bestie. Retry setup later.",
        );
      held = true;
      awaitingModel = { ...(selected ? { selected } : {}), options };
      publish({
        status: "choose-model",
        message,
        models,
        record,
        connection,
      });
    };
    save();

    progress("Signing in to Builderlab…");
    try {
      await builderlab.ensureSignedIn(signal);
    } catch (error) {
      check();
      throw new Error(
        `Sign in to Builderlab to set up Bestie. ${explain(error)}`,
      );
    }
    check();

    if (agents.snapshot().status !== "ready")
      throw new Error("Your agents are still loading. Retry in a moment.");
    const account = builderlab.account();
    const remoteAgents = async () => {
      const rows = await builderlab.list(signal);
      check();
      if (builderlab.account() !== account)
        throw new DOMException("Builderlab session changed.", "AbortError");
      return rows;
    };
    // Builderlab says which agents exist; Agents says which are listed in
    // this community, and may still be reading that list after a reconnect.
    let remote = await remoteAgents();
    let agent: Agent | undefined;
    // Agents may list a Bestie this Builderlab account doesn't have: one
    // made by another account, revoked, or unfinished past its expiry.
    const inAccount = (pubkey: string) =>
      remote.some((row) => row.pubkey === pubkey && row.status !== "Revoked");
    if (record.agent && options.createNew && !inAccount(record.agent)) {
      // A replacement gets a fresh home and fresh instructions. The old
      // home keeps its conversation with the old agent, whose membership
      // would fail the replacement's roster check.
      record.agent = undefined;
      record.promptVersion = undefined;
      record.channelId = crypto.randomUUID();
      record.channelOperation = undefined;
      record.channelFailed = undefined;
      record.welcomeId = undefined;
      record.welcomeFailed = undefined;
      record.complete = undefined;
      save();
    }
    if (record.agent) {
      const chosen = record.agent;
      agent = agents.find(chosen);
      if (agent && agent.place !== "hosted")
        throw new Error(
          "Your saved Bestie no longer runs on Builderlab. Review Agents before retrying.",
        );
      if (!inAccount(chosen))
        throw new CreateNewError(
          "Your saved Bestie isn't in this Builderlab account. Sign in to the account that created it and retry, or create a new Bestie.",
        );
    } else {
      const candidates = agents
        .snapshot()
        .agents.filter(
          (row) =>
            row.type === BUILDERLAB_TYPE &&
            row.name === NAME &&
            row.owner === owner &&
            row.place === "hosted" &&
            (!options.createNew || inAccount(row.pubkey)),
        );
      if (selected && !candidates.some((row) => row.pubkey === selected))
        throw new Error("That Bestie is no longer available. Retry setup.");
      if (candidates.length > 1 && !selected) {
        held = true;
        publish({
          status: "choose-agent",
          message:
            "You already have several Besties. Choose one to use for this channel.",
          candidates,
          record,
          connection,
        });
        return;
      }
      agent =
        candidates.find((row) => row.pubkey === selected) ?? candidates[0];
      if (!agent) {
        // Never make a second Bestie because this community's list is unread.
        if (
          !options.createNew &&
          remote.some(
            (row) =>
              row.name === NAME &&
              row.status === "Active" &&
              !agents.find(row.pubkey),
          )
        )
          throw new CreateNewError(
            "Your Builderlab account already has a Bestie that isn't listed in this community yet. Wait for your agents to load, then retry, or create a new Bestie for this community.",
          );
        // Agents resumes an unfinished agent of the same name rather than
        // making another, and this one can no longer finish.
        if (
          agents
            .snapshot()
            .agents.some(
              (row) =>
                row.type === BUILDERLAB_TYPE &&
                row.name === NAME &&
                row.owner === owner &&
                row.unfinished &&
                !inAccount(row.pubkey),
            )
        )
          throw new Error(
            "An unfinished Bestie that this Builderlab account no longer has is still in Agents. Delete it in Agents, then create a new Bestie.",
          );
        if (!options.model) {
          await askForModel(
            "Choose the model and reasoning effort Bestie runs on.",
          );
          return;
        }
        progress("Creating Bestie…");
        const instructions = bestieInstructions(owner, record.channelId);
        // A failure after Builderlab made the agent leaves it unfinished in
        // Agents; the next attempt finds and finishes it instead.
        agent = await agents.create({
          type: BUILDERLAB_TYPE,
          name: NAME,
          picture: randomAgentAvatar().url,
          config: {
            instructions,
            ...options.model,
            subject: account.subject,
          },
        });
        // Finishing gave this agent its instructions with its model.
        if (!agent.unfinished)
          record.promptVersion = promptVersion(instructions);
        remote = await remoteAgents();
      }
      record.agent = agent.pubkey;
      save();
      check();
    }
    if (agent?.unfinished) {
      progress("Finishing Bestie's setup…");
      await agents.finish(agent.pubkey);
      check();
      remote = await remoteAgents();
    }
    const pubkey = record.agent;
    const listed = remote.find((item) => item.pubkey === pubkey);
    // Builderlab runs an agent only on a valid model choice. An older
    // server reports no status, and its agents run on its default.
    if (
      listed?.modelSelectionStatus &&
      listed.modelSelectionStatus !== "valid"
    ) {
      if (!options.model) {
        await askForModel(
          "Bestie needs a model and reasoning effort before it can reply. Choose one to continue.",
        );
        return;
      }
      progress("Choosing Bestie's model…");
      await builderlab.updateModel(
        listed,
        options.model.modelId,
        options.model.reasoningEffort,
        signal,
      );
      check();
    }

    const instructions = bestieInstructions(owner, record.channelId);
    if (instructions.length > MAX_INSTRUCTIONS_LENGTH)
      throw new Error(
        `Bestie's instructions are ${instructions.length} characters; Builderlab allows ${MAX_INSTRUCTIONS_LENGTH}. Shorten prompt.ts and retry.`,
      );
    if (record.promptVersion !== promptVersion(instructions)) {
      progress("Updating Bestie's instructions…");
      const row = remote.find((item) => item.pubkey === pubkey);
      if (!row)
        throw new Error(
          "Sign in to the Builderlab account that created Bestie, then retry setup.",
        );
      await builderlab.updateInstructions(row, instructions, signal);
      check();
      record.promptVersion = promptVersion(instructions);
      save();
    }

    progress("Opening your private Bestie channel…");
    const outbox = session.outbox;
    if (!outbox) throw new Error("This community cannot save Bestie setup.");
    await outbox.ready();
    check();
    const verifyHome = async () => {
      const home = await session.channelWrites.refreshMembership(
        record.channelId,
      );
      check();
      if (
        home.channelType !== "solo" ||
        home.visibility !== "private" ||
        home.archived ||
        !home.members?.includes(owner) ||
        home.members.some((member) => member !== owner && member !== pubkey)
      )
        throw new Error(
          "Bestie's channel must be private and contain only you and Bestie. Review its members before continuing.",
        );
      return home;
    };
    async function recoverMissing(
      field: "channelOperation" | "welcomeId",
      failed: "channelFailed" | "welcomeFailed",
    ) {
      const id = record[field];
      if (!id || outbox?.snapshot().some((item) => item.event.id === id))
        return;
      // The journal lacks the intent: it was delivered, dismissed after a
      // definite failure, or lost with the app before its own save
      // committed, since the checkpoint is saved as soon as the intent is
      // queued. Strong readback keeps an effect that reached the relay;
      // only one the relay never saw is replaced.
      const events = await session.read(
        [{ ids: [id], limit: 1, consistency: "strong" }],
        { fresh: true, signal },
      );
      check();
      if (!events.some((event) => event.id === id)) {
        record[field] = undefined;
        record[failed] = undefined;
        save();
      }
    }
    async function delivered(
      field: "channelOperation" | "welcomeId",
      failed: "channelFailed" | "welcomeFailed",
    ) {
      const id = record[field];
      if (!id) return;
      // A retry may reach the relay even when an earlier attempt was rejected.
      // Retire the old classification before starting a new delivery attempt.
      record[failed] = undefined;
      save();
      try {
        await session.channelWrites.delivered(id, active);
      } catch (error) {
        record[failed] = session.channelWrites.failed(id) || undefined;
        save();
        throw error;
      }
      check();
    }
    await session.channels.resolve?.([record.channelId], {
      fresh: true,
      signal,
    });
    check();
    const channel = () =>
      session.channels
        .list()
        .channels.find((row) => row.id === record.channelId);
    if (!channel()) {
      await recoverMissing("channelOperation", "channelFailed");
      record.channelOperation ??= outbox
        .snapshot()
        .find(
          (item) =>
            item.event.kind === 9007 &&
            item.event.tags.some(
              ([name, value]) => name === "h" && value === record.channelId,
            ),
        )?.event.id;
      // A named Solo chat: KGoose gives Bestie one session there with recent
      // history, and the relay adds Bestie in the create.
      record.channelOperation ??= session.channelWrites.create(
        record.channelId,
        NAME,
        undefined,
        true,
        [pubkey],
      );
      save();
      await delivered("channelOperation", "channelFailed");
      await session.channelWrites.refresh(
        record.channelId,
        { member: owner },
        false,
      );
      check();
    }
    const home = await verifyHome();
    if (!home.members?.includes(pubkey)) {
      progress("Inviting Bestie to the channel…");
      // Agents join a Solo chat through the agent path, not member additions.
      // That path admits only listed agents, so read the new listing first.
      await session.agentChoices.refresh(true, { fresh: true });
      check();
      await session.channelWrites.addAgents(record.channelId, [pubkey], active);
      check();
    }
    const confirmed = await verifyHome();
    if (!confirmed.members?.includes(pubkey))
      throw new Error(
        "Bestie's invitation has not been confirmed. Retry setup.",
      );

    await recoverMissing("welcomeId", "welcomeFailed");
    record.welcomeId ??= outbox
      .snapshot()
      .find(
        (item) => item.recovery?.key === `bestie-welcome:${record.channelId}`,
      )?.event.id;
    if (!record.welcomeId) {
      record.welcomeId = session.messages.send(
        record.channelId,
        "🤖 Sent by Bestie setup: @Bestie, introduce yourself and help me get started with Buzz.",
        [pubkey],
        [],
        { key: `bestie-welcome:${record.channelId}`, value: pubkey },
      );
      save();
    }
    await delivered("welcomeId", "welcomeFailed");
    record.complete = true;
    save();
    publish({
      status: "ready",
      message: "Your Bestie is set up.",
      record,
      connection,
    });
  }
  function run(selected?: string, options?: SetupOptions) {
    if (disposed) return Promise.resolve();
    if (work) return work;
    const controller = new AbortController();
    operation = controller;
    held = false;
    const task = async () => {
      const current = scope();
      if (!current) throw new Error("Connect to a community first.");
      // One setup per owner and community across this app's windows.
      if (typeof navigator !== "undefined" && navigator.locks)
        await navigator.locks.request(
          current.key,
          { signal: controller.signal },
          () => provision(controller.signal, selected, options),
        );
      else await provision(controller.signal, selected, options);
    };
    work = task()
      .catch((error: unknown) => {
        if (disposed || controller.signal.aborted) return;
        held = true;
        publish({
          ...state,
          status: "error",
          message: explain(error),
          canCreateNew: error instanceof CreateNewError,
        });
      })
      .finally(() => {
        if (operation === controller) operation = undefined;
        work = undefined;
        // An aborted attempt reports the state it left behind.
        if (controller.signal.aborted) refresh();
      });
    return work;
  }
  return {
    snapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setup: (selected?: string, options?: SetupOptions) =>
      run(selected, options),
    /** Resumes the setup that stopped for a model choice. */
    chooseModel(model: ModelChoice) {
      const request = awaitingModel;
      awaitingModel = undefined;
      return run(request?.selected, { ...request?.options, model });
    },
    dispose() {
      disposed = true;
      operation?.abort();
      stopRelay();
      stopAgents();
      listeners.clear();
    },
  };
}
export type RemoteBestie = ReturnType<typeof createRemoteBestie>;
