import { useHuddleRequestFocus } from "./useHuddleRequestFocus";
import { HuddleAudioSettings } from "./HuddleAudioSettings";
import { LayoutGroup } from "motion/react";
import { useId } from "react";
import { formatPublicKey } from "../../shared/identity/public-key";
import { useState, useSyncExternalStore } from "react";
import type { RelayData } from "../../features/relay/service";
import { HuddleAvatarStack } from "./HuddleAvatarStack";
import type { HuddleWindow } from "../../features/huddle/window";
import type { Huddles } from "../../features/huddle/service";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { ToastNotice } from "../../shared/design-system/ui/Toast";
import {
  MicrophoneIcon,
  MicrophoneSlashIcon,
} from "../../shared/design-system/icons";
import styles from "./Huddles.module.css";

export function HuddleWaveform({
  level = 0,
  muted = false,
}: {
  level?: number;
  muted?: boolean;
}) {
  return (
    <span className={styles.waveform} data-muted={muted} aria-hidden="true">
      {[0.4, 0.75, 1, 0.6, 0.35].map((weight, i) => (
        <span
          key={weight}
          style={{
            height: `${3 + (muted ? 0 : level * weight * 17 + (i % 2) * 2)}px`,
          }}
        />
      ))}
    </span>
  );
}
export function HuddleCapsule(props: {
  huddles: Huddles;
  relay: RelayData;
  companion: HuddleWindow;
}) {
  return (
    <LayoutGroup id={useId()}>
      <HuddleCapsuleContent {...props} />
    </LayoutGroup>
  );
}
function HuddleCapsuleContent({
  huddles,
  relay,
  companion,
}: {
  huddles: Huddles;
  relay: RelayData;
  companion: HuddleWindow;
}) {
  const call = useSyncExternalStore(huddles.subscribe, huddles.snapshot);
  const { session } = useSyncExternalStore(relay.subscribe, relay.snapshot);
  const profiles = useSyncExternalStore(
    session.profiles.subscribe,
    session.profiles.snapshot,
  );
  const presentation = useSyncExternalStore(
    companion.subscribe,
    companion.snapshot,
  );
  const [error, setError] = useState<string>();
  const focus = useHuddleRequestFocus(call.phase === "connected", call.error);
  const audioUnavailable = call.error
    ?.toLowerCase()
    .includes("huddle audio unavailable in this deployment");
  if (call.phase === "error")
    return (
      <ToastNotice
        title={
          audioUnavailable
            ? "Huddle audio unavailable"
            : "Couldn’t connect to Huddle"
        }
        description={
          audioUnavailable
            ? "Huddle audio isn’t available on this server. A relay administrator needs to check its configuration."
            : `${call.error || "The connection failed."} Try the headphone button again.`
        }
        closeLabel="Dismiss Huddle error"
        onDismiss={() => void huddles.leave()}
      />
    );
  if (
    (call.phase === "incoming" ||
      (call.phase === "connecting" && call.requester)) &&
    call.destination &&
    call.room
  ) {
    const { destination, room } = call;
    const caller =
      profiles.get(call.requester ?? "")?.name ||
      formatPublicKey(call.requester ?? "") ||
      "Someone";
    return (
      <fieldset
        id="huddle-capsule"
        tabIndex={-1}
        className={`${styles.capsule} glass-primary`}
        ref={focus.requestRef}
        aria-label="Huddle request"
      >
        <Button
          size="sm"
          variant="ghost"
          aria-label="Open Huddle request"
          style={{ padding: "var(--space-1)" }}
          onClick={() => {
            void companion.open().catch(() => {});
          }}
        >
          <span className={styles.capsuleContent}>
            <HuddleAvatarStack
              thinking={call.thinking}
              speakers={call.speakers}
              participants={call.participants}
              relay={relay}
              transition
            />
            <span className={styles.callerName}>
              {Array.from(caller).slice(0, 80).join("")} calling
            </span>
          </span>
        </Button>
        {call.error && (
          <span role="alert" className="text-caption text-danger">
            {call.error}
          </span>
        )}
        <span className={styles.requestCompactActions}>
          <Button
            size="sm"
            variant="subtle"
            data-huddle-join=""
            disabled={call.phase === "connecting"}
            onClick={() => {
              focus.cancel.current?.focus({ preventScroll: true });
              void huddles.join(destination, room);
            }}
          >
            Join
          </Button>
          <Button
            size="sm"
            variant="destructive"
            ref={focus.cancel}
            onClick={() => {
              void huddles.leave();
            }}
          >
            {call.phase === "connecting" ? "Cancel" : "Decline"}
          </Button>
        </span>
      </fieldset>
    );
  }
  if (call.phase === "connecting")
    return (
      <fieldset
        id="huddle-capsule"
        tabIndex={-1}
        className={`${styles.capsule} glass-primary`}
        ref={focus.requestRef}
        aria-label="Connecting to Huddle"
      >
        <span className={styles.callerName}>Connecting to Huddle…</span>
        <Button
          size="sm"
          variant="destructive"
          ref={focus.cancel}
          onClick={() => void huddles.leave()}
        >
          Cancel
        </Button>
      </fieldset>
    );
  if (call.phase !== "connected") return null;
  return (
    <div className={styles.capsuleWrap}>
      {call.error && (
        <ToastNotice
          title="Agent voice stopped"
          description={call.error}
          closeLabel="Dismiss agent voice error"
          onDismiss={() => {
            if (call.id) huddles.voiceError(call.id);
          }}
        />
      )}
      {presentation.error && (
        <ToastNotice
          title="Couldn’t update Huddle"
          description={presentation.error}
          closeLabel="Dismiss Huddle window error"
          onDismiss={companion.dismissError}
        />
      )}
      <fieldset
        id="huddle-capsule"
        tabIndex={-1}
        className={`${styles.capsule} glass-primary`}
        aria-label="Active Huddle"
      >
        <Button
          variant="ghost"
          size="sm"
          style={{ padding: "var(--space-1)", paddingLeft: "var(--space-2)" }}
          aria-label={`Open Huddle window for ${call.destination?.channelName ?? "conversation"}`}
          title="Open Huddle window"
          onClick={() => {
            setError(undefined);
            void companion.open().catch((e) => setError(String(e)));
          }}
        >
          <span className={styles.capsuleContent}>
            <HuddleWaveform level={call.level ?? 0} muted={call.muted} />
            <HuddleAvatarStack
              thinking={call.thinking}
              speakers={call.speakers}
              participants={call.participants}
              relay={relay}
              transition
            />
          </span>
        </Button>
        <IconButton
          hint="familiar"
          size="toolbar"
          variant="ghost"
          ref={focus.mute}
          aria-label={call.muted ? "Unmute" : "Mute"}
          title={call.muted ? "Unmute" : "Mute"}
          aria-pressed={call.muted}
          onClick={() => huddles.mute()}
          icon={
            call.muted ? (
              <MicrophoneSlashIcon size={16} />
            ) : (
              <MicrophoneIcon size={16} />
            )
          }
        />
        <HuddleAudioSettings
          compact
          state={call.audioSettings}
          refresh={huddles.refreshAudioSettings}
          select={huddles.selectAudioDevice}
        />
        <span className={styles.capsuleDivider} aria-hidden="true" />
        <Button
          size="sm"
          variant="destructive"
          data-huddle-leave=""
          style={{ alignSelf: "stretch" }}
          aria-label="Leave huddle"
          onClick={() => void huddles.leave()}
        >
          Leave
        </Button>
      </fieldset>
      {(error || presentation.failed) && (
        <span role="alert" className={styles.capsuleError}>
          Couldn’t open Huddle window. Try again.
        </span>
      )}
    </div>
  );
}
