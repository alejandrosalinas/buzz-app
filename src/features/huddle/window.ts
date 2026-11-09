import { isBuzzLink } from "../navigation/buzz-links";
import type { AudioSettingsState } from "./audio-settings";
import type { ComposerReader } from "./composer-contract";
import { createHuddleComposerOwner } from "./composer-owner";
import { Channel, invoke } from "@tauri-apps/api/core";
import type { RelayData } from "../relay/service";
import { formatPublicKey } from "../../shared/identity/public-key";
import type { Huddles } from "./service";
import { createHuddleDiscussion, type HuddleDiscussion } from "./discussion";

export type HuddleView = {
  id: string;
  title: string;
  phase: "incoming" | "connecting" | "connected" | "leaving";
  error?: string | undefined;
  muted: boolean;
  level: number;
  dark: boolean;
  discussion?: HuddleDiscussion | undefined;
  audioSettings?: AudioSettingsState | undefined;
  participants: {
    key: string;
    name: string;
    picture: string | null;
    own: boolean;
    listening?: boolean;
    thinking?: boolean;
    level: number;
  }[];
};
export type HuddleAction =
  | "openLink"
  | "join"
  | "decline"
  | "refreshAudio"
  | "inputDevice"
  | "outputDevice"
  | "mute"
  | "leave"
  | "minimize"
  | "thread"
  | "send"
  | "older"
  | "retry"
  | "retryMessage"
  | "discardMessage";
export type HuddleWindowAction = HuddleAction | "closed";
export type WindowBridge = {
  resetIncoming?(): Promise<void>;
  open(
    view: HuddleView,
    act: (id: string, action: HuddleWindowAction, text?: string) => void,
  ): Promise<void>;
  update(id: string, view: HuddleView | null): Promise<void>;
};
let sentDiscussion: { id: string; version: number | undefined } | undefined;
export const nativeHuddleWindow: WindowBridge = {
  resetIncoming: () => invoke("huddle_window_reset_incoming"),
  async open(view, act) {
    const actions = new Channel<{
      id: string;
      action: HuddleWindowAction;
      text?: string;
    }>();
    actions.onmessage = ({ id, action, text }) => act(id, action, text);
    await invoke("huddle_window_open", {
      view: { ...view, discussionOpen: !!view.discussion },
      actions,
    });
    sentDiscussion = { id: view.id, version: view.discussion?.version };
  },
  async update(id, view) {
    const unchanged =
      sentDiscussion?.id === id &&
      sentDiscussion.version === view?.discussion?.version;
    await invoke("huddle_window_update", {
      id,
      view: view && {
        ...view,
        discussionOpen: !!view.discussion,
        discussion: unchanged ? undefined : view.discussion,
      },
    });
    sentDiscussion = view
      ? { id, version: view.discussion?.version }
      : undefined;
  },
};

/** Companion is a remote view; only this main-window owner can operate the call. */
export function createHuddleWindow(
  huddles: Huddles,
  relay: RelayData,
  bridge = nativeHuddleWindow,
  extensions?: ComposerReader,
  openLink?: (target: string) => boolean,
  agents?: import("../agents/service").Agents,
) {
  let disposed = false;
  let attempted: string | undefined;
  let revision = 0;
  let presentation: { visible: boolean; failed: boolean; error?: string } = {
    visible: false,
    failed: false,
  };
  const listeners = new Set<() => void>();
  function publish(visible: boolean, failed = false, error?: string) {
    if (
      presentation.visible === visible &&
      presentation.failed === failed &&
      presentation.error === error
    )
      return;
    presentation = { visible, failed, ...(error ? { error } : {}) };
    for (const listener of listeners) listener();
  }
  let opened: string | undefined;
  let opening: Promise<void> | undefined;
  let stopProfiles: (() => void) | undefined;
  let profileSession: ReturnType<RelayData["snapshot"]>["session"] | undefined;
  let ensured = "";
  let ensuring = "";
  let discussion: ReturnType<typeof createHuddleDiscussion> | undefined;
  let composer: ReturnType<typeof createHuddleComposerOwner> | undefined;
  const closeDiscussion = () => {
    composer?.dispose();
    composer = undefined;
    discussion?.dispose();
    discussion = undefined;
  };
  // Serialize updates with window creation so Leave during Open cannot orphan a view.
  let updates = bridge.resetIncoming?.() ?? Promise.resolve();
  void updates.catch(() => {});
  function view(): HuddleView | null {
    const call = huddles.snapshot();
    if (
      !call.id ||
      !call.destination ||
      !["incoming", "connecting", "connected", "leaving"].includes(call.phase)
    )
      return null;
    const session = relay.snapshot().session;
    const profiles = session.profiles.snapshot();
    return {
      id: call.id,
      title: Array.from(call.destination.channelName).slice(0, 1000).join(""),
      phase: call.phase as HuddleView["phase"],
      muted: call.muted,
      error: call.error
        ? Array.from(call.error).slice(0, 2000).join("")
        : undefined,
      audioSettings:
        call.audioSettings && projectAudioSettings(call.audioSettings),
      level: call.level ?? 0,
      dark: document.documentElement.classList.contains("dark"),
      discussion: discussion
        ? { ...discussion.snapshot(), composer: composer?.token }
        : undefined,
      participants: call.participants.map((key) => {
        const profile = profiles.get(key);
        const picture = profile?.picture
          ? session.media(profile.picture)
          : undefined;
        return {
          key,
          name: Array.from(
            profile?.name || formatPublicKey(key) || "Participant",
          )
            .slice(0, 1000)
            .join(""),
          picture:
            picture && new TextEncoder().encode(picture).length <= 8192
              ? picture
              : null,
          own: key === call.destination?.viewer,
          listening:
            call.phase === "connected" && !!call.listening?.includes(key),
          thinking:
            call.phase === "connected" && !!call.thinking?.includes(key),
          level: call.speakers?.[key] ?? 0,
        };
      }),
    };
  }
  function sync() {
    if (opening) return;
    let next = disposed ? null : view();
    const call = huddles.snapshot();
    // Keep the same native window and caller portrait through acceptance. Open
    // replaces its presentation/action owner once the new call ID is connected.
    if (
      next?.phase === "connecting" &&
      call.requester &&
      opened &&
      opened === call.room
    )
      next = { ...next, id: opened };
    if (
      next &&
      ["incoming", "connected"].includes(next.phase) &&
      attempted !== next.id
    ) {
      void open().catch(() => {});
      return;
    }
    if (!opened) {
      if (!next) publish(false);
      return;
    }
    const id = opened;
    const live = next?.id === id ? next : null;
    updates = updates.catch(() => {}).then(() => bridge.update(id, live));
    // An action is acknowledged before this asynchronous native update. Surface
    // its failure instead of leaving Chat looking like an unresponsive button.
    void updates.catch((error: unknown) => {
      if (!disposed && opened === id)
        publish(
          true,
          false,
          `Couldn’t update the Huddle window: ${String(error).slice(0, 500)}`,
        );
    });
    if (!live) {
      // Ending an attempt may restore the same invitation after a failure.
      // Explicit minimize uses its own path and keeps auto-open suppressed.
      if (attempted === id) attempted = undefined;
      closeDiscussion();
      publish(false);
      opened = undefined;
      stopProfiles?.();
      stopProfiles = undefined;
    } else {
      const session = relay.snapshot().session;
      if (profileSession !== session) {
        profileSession = session;
        ensured = "";
        ensuring = "";
        stopProfiles?.();
        stopProfiles = session.profiles.subscribe(sync);
      }
      // A purge drops loaded names; its generation makes the same keys a new demand.
      const keys = live.participants.length
        ? `${session.profiles.generation?.() ?? 0}|${live.participants.map((p) => p.key).join(":")}`
        : "";
      if (keys && keys !== ensured && keys !== ensuring) {
        ensuring = keys;
        void session.profiles
          .ensure(
            live.participants.map((p) => p.key),
            "background",
          )
          .then(() => {
            if (profileSession === session) ensured = keys;
          })
          .catch(() => {})
          .finally(() => {
            if (profileSession === session && ensuring === keys) ensuring = "";
          });
      }
    }
  }
  const stop = huddles.subscribe(sync);
  const theme = new MutationObserver(sync);
  theme.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
  async function open() {
    if (disposed) return;
    if (opening) return opening;
    const next = view();
    if (!next || !["incoming", "connected"].includes(next.phase)) return;
    const version = ++revision;
    attempted = next.id;
    publish(true);
    stopProfiles?.();
    stopProfiles = relay.snapshot().session.profiles.subscribe(sync);
    opened = next.id;
    opening = (async () => {
      await updates.catch(() => {});
      try {
        await bridge.open(next, (id, action, text) => {
          const call = huddles.snapshot();
          const accepting =
            call.phase === "connecting" &&
            !!call.requester &&
            call.room === id &&
            opened === id;
          if (
            disposed ||
            revision !== version ||
            (call.id !== id &&
              !(
                accepting &&
                (action === "closed" ||
                  action === "minimize" ||
                  action === "decline")
              ))
          )
            return;
          if (action === "closed" || action === "minimize") {
            if (opened !== id) return;
            if (accepting) attempted = call.id;
            opened = undefined;
            closeDiscussion();
            stopProfiles?.();
            stopProfiles = undefined;
            updates = updates
              .catch(() => {})
              .then(() => bridge.update(id, null));
            void updates.catch(() => {});
            publish(false);
          } else if (huddles.snapshot().phase === "incoming") {
            const request = huddles.snapshot();
            if (action === "decline") void huddles.leave();
            else if (action === "join" && request.destination && request.room)
              void huddles.join(request.destination, request.room);
          } else if (action === "mute") huddles.mute();
          else if (action === "leave" || (accepting && action === "decline"))
            void huddles.leave();
          else if (action === "refreshAudio") huddles.refreshAudioSettings();
          else if (
            (action === "inputDevice" || action === "outputDevice") &&
            typeof text === "string"
          )
            huddles.selectAudioDevice(
              action === "inputDevice" ? "input" : "output",
              text,
            );
          else if (action === "thread") {
            publish(true);
            try {
              const call = huddles.snapshot();
              if (discussion) closeDiscussion();
              else if (
                call.room &&
                call.destination &&
                call.phase === "connected"
              ) {
                const session = relay.snapshot().session;
                const roomDiscussion = createHuddleDiscussion(
                  session,
                  call.room,
                  call.destination.channelId,
                  () => {
                    composer?.refresh();
                    sync();
                  },
                );
                discussion = roomDiscussion;
                composer = createHuddleComposerOwner(
                  session,
                  call.room,
                  call.destination.channelId,
                  extensions,
                  () =>
                    !disposed &&
                    opened === id &&
                    relay.snapshot().session === session &&
                    huddles.snapshot().id === id,
                  roomDiscussion.available,
                  agents,
                );
              }
            } catch (error) {
              closeDiscussion();
              publish(
                true,
                false,
                `Couldn’t open Huddle chat: ${String(error).slice(0, 500)}`,
              );
            }
            sync();
          } else if (
            action === "openLink" &&
            text &&
            isBuzzLink(text) &&
            text.length <= 8192
          ) {
            const connection = relay.snapshot();
            if (
              call.phase === "connected" &&
              connection.status === "ready" &&
              connection.scope === call.destination?.scope &&
              connection.viewer === call.destination?.viewer
            )
              openLink?.(text);
          } else if (action === "send" && typeof text === "string")
            void discussion?.send(text);
          else if (action === "older") discussion?.older();
          else if (action === "retry") discussion?.retry();
          else if (
            (action === "retryMessage" || action === "discardMessage") &&
            text
          )
            discussion?.recover(text, action === "discardMessage");
        });
      } catch (error) {
        // Include partial-creation cleanup in the promise disposal waits for.
        try {
          await bridge.update(next.id, null);
        } finally {
          closeDiscussion();
          opened = undefined;
          stopProfiles?.();
          stopProfiles = undefined;
          publish(false, true);
        }
        throw error;
      } finally {
        opening = undefined;
        sync();
      }
    })();
    return opening;
  }
  if (huddles.snapshot().phase === "incoming") sync();
  return {
    open,
    snapshot: () => presentation,
    dismissError: () => publish(presentation.visible, presentation.failed),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async dispose() {
      disposed = true;
      closeDiscussion();
      stop();
      theme.disconnect();
      await opening?.catch(() => {});
      sync();
      stopProfiles?.();
      await updates;
    },
  };
}
export type HuddleWindow = ReturnType<typeof createHuddleWindow>;

/** Native presentation accepts bounded UTF-8 strings. Never truncate device IDs. */
export function projectAudioSettings(
  state: AudioSettingsState,
): AudioSettingsState {
  const bytes = (value: string) => new TextEncoder().encode(value).length;
  const label = (value: string) => Array.from(value).slice(0, 1000).join("");
  const devices = (items: AudioSettingsState["inputs"]) =>
    items
      .filter((item) => bytes(item.id) <= 4096)
      .slice(0, 128)
      .map((item) => ({ id: item.id, label: label(item.label) }));
  return {
    ...state,
    inputs: devices(state.inputs),
    outputs: devices(state.outputs),
    input: bytes(state.input) <= 4096 ? state.input : "",
    output: bytes(state.output) <= 4096 ? state.output : "",
    error: state.error && Array.from(state.error).slice(0, 2000).join(""),
  };
}
