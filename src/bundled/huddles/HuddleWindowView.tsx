import { HuddleMinimizeIcon } from "./HuddleMinimizeIcon";
import { isBuzzLink } from "../../features/navigation/buzz-links";
import { useHuddleRequestFocus } from "./useHuddleRequestFocus";
import { HuddleAudioSettings } from "./HuddleAudioSettings";
import { LayoutGroup } from "motion/react";
import { useId, useEffectEvent } from "react";
import { PanelDock } from "../../features/panels/PanelDock";
import { HuddleRequestView } from "./HuddleRequestView";
import type { HuddleAction, HuddleView } from "../../features/huddle/window";
import { useLayoutEffect, useRef, useState } from "react";
import { useHuddleComposer } from "./HuddleComposer";
import { HuddleAvatarCloud } from "./HuddleAvatarCloud";
import { HuddleDiscussionView } from "./HuddleDiscussionView";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  ChatCircleIcon,
  MicrophoneIcon,
  MicrophoneSlashIcon,
  PhoneEndIcon,
} from "../../shared/design-system/icons";
import styles from "./Huddles.module.css";

type WindowProps = {
  view: HuddleView;
  act(action: HuddleAction, text?: string): void;
  error?: string | undefined;
};
export function HuddleWindowView(props: WindowProps) {
  return (
    <LayoutGroup id={useId()}>
      <HuddleWindowContent {...props} />
    </LayoutGroup>
  );
}
function HuddleWindowContent({ view, act, error }: WindowProps) {
  const focus = useHuddleRequestFocus(
    view.phase === "connected",
    view.error,
    true,
  );
  const incoming = useRef(false);
  if (view.phase === "incoming") incoming.current = true;
  else if (view.phase !== "connecting") incoming.current = false;
  const composer = useHuddleComposer(view.discussion?.composer);
  const layout = useRef<HTMLDivElement>(null);
  const call = useRef<HTMLElement>(null);
  const open = !!view.discussion;
  const [closing, setClosing] = useState(false);
  const closeDispatched = useRef(false);
  const reopenAfterClose = useRef(false);
  const [hold, setHold] = useState<{
    width: number;
    open: boolean;
  }>();
  useLayoutEffect(() => {
    if (hold && open === hold.open) setHold(undefined);
  }, [open, hold]);
  useLayoutEffect(() => {
    if (error) {
      closeDispatched.current = false;
      reopenAfterClose.current = false;
      setHold(undefined);
      setClosing(false);
    }
  }, [error]);
  const requestToggle = useEffectEvent(() => {
    act("thread");
  });
  useLayoutEffect(() => {
    if (!open) {
      setClosing(false);
      closeDispatched.current = false;
      if (reopenAfterClose.current) {
        reopenAfterClose.current = false;
        requestToggle();
      }
    }
    if (!closing || !open) return;
    // Finish the shared panel exit before the host shrinks the native window.
    const panel =
      layout.current?.querySelector<HTMLElement>("[data-panel-dock]");
    const animations = panel?.getAnimations() ?? [];
    let cancelled = false;
    void Promise.allSettled(
      animations.map((animation) => animation.finished),
    ).then(() => {
      if (!cancelled) {
        closeDispatched.current = true;
        requestToggle();
      }
    });
    return () => {
      cancelled = true;
    };
  }, [closing, open]);
  if (
    view.phase === "incoming" ||
    (view.phase === "connecting" && incoming.current)
  )
    return (
      <HuddleRequestView
        view={view}
        act={act}
        error={error || view.error}
        focus={focus}
      />
    );
  const toggleChat = () => {
    if (closing) {
      // Once sent, wait for the closed presentation before issuing its inverse.
      if (closeDispatched.current) {
        reopenAfterClose.current = !reopenAfterClose.current;
        return;
      }
      setClosing(false);
      setHold(undefined);
      return;
    }
    if (call.current)
      setHold({
        width: call.current.getBoundingClientRect().width,
        open: !open,
      });
    if (
      open &&
      !document.documentElement.hasAttribute("data-keyboard-input") &&
      !window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      setClosing(true);
      return;
    }
    act("thread");
  };
  return (
    <div
      ref={layout}
      className={styles.windowLayout}
      data-chat={!!view.discussion || undefined}
    >
      <main
        ref={call}
        data-buzz-ui=""
        className={styles.window}
        style={hold ? { flex: "0 0 auto", width: hold.width } : undefined}
      >
        {view.phase !== "connected" && (
          <p role="status" className="text-body text-secondary">
            {view.phase === "connecting"
              ? "Connecting your microphone…"
              : "Leaving…"}
          </p>
        )}
        <HuddleAvatarCloud
          participants={view.participants}
          muted={view.muted}
        />
        <footer className={styles.windowFooter}>
          {(error || view.error) && (
            <p role="alert" className="text-caption text-secondary">
              {error || view.error}
            </p>
          )}
          <div className={styles.windowControlBar}>
            <HuddleAudioSettings
              quiet
              state={view.audioSettings}
              refresh={() => act("refreshAudio")}
              select={(kind, id) =>
                act(kind === "input" ? "inputDevice" : "outputDevice", id)
              }
            />
            <div className={styles.windowControls}>
              <IconButton
                hint="familiar"
                size="large"
                variant="glass"
                shape="round"
                ref={focus.mute}
                aria-label={view.muted ? "Unmute" : "Mute"}
                title={view.muted ? "Unmute" : "Mute"}
                aria-pressed={view.muted}
                disabled={view.phase !== "connected"}
                onClick={() => act("mute")}
                icon={view.muted ? <MicrophoneSlashIcon /> : <MicrophoneIcon />}
              />
              <IconButton
                size="large"
                variant="glass"
                shape="round"
                aria-label="Huddle chat"
                title="Huddle chat"
                aria-expanded={open && !closing}
                onClick={toggleChat}
                icon={<ChatCircleIcon />}
              />
              <IconButton
                hint="familiar"
                size="large"
                variant="glass"
                shape="round"
                data-huddle-leave=""
                aria-label="Leave huddle"
                title="Leave huddle"
                disabled={view.phase === "leaving"}
                onClick={() => act("leave")}
                icon={<PhoneEndIcon />}
              />
            </div>
            <IconButton
              size="large"
              variant="ghost"
              shape="round"
              aria-label="Minimize Huddle to compact controls"
              title="Minimize Huddle"
              onClick={() => act("minimize")}
              icon={<HuddleMinimizeIcon />}
            />
          </div>
        </footer>
      </main>
      {open && (
        <PanelDock open={!closing} className={styles.windowDiscussion}>
          {view.discussion && (
            <aside
              className={styles.windowDiscussionBody}
              aria-label="Huddle chat panel"
            >
              <HuddleDiscussionView
                allowImageCopy={false}
                discussion={view.discussion}
                openLink={(url) => {
                  if (!isBuzzLink(url)) return false;
                  act("openLink", url);
                  return true;
                }}
                composer={composer}
                older={() => act("older")}
                retry={() => act("retry")}
                recover={(id, dismiss) =>
                  act(dismiss ? "discardMessage" : "retryMessage", id)
                }
              />
            </aside>
          )}
        </PanelDock>
      )}
    </div>
  );
}
