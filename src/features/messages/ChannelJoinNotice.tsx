import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ChannelLifecycleCapability } from "../relay/channel-lifecycle";
import { ChannelLifecycleUnconfirmed } from "../relay/channel-lifecycle";
import { Button } from "../../shared/design-system/ui/Button";
import { useToastClearance } from "../../shared/design-system/ui/Toast";
import styles from "./Messages.module.css";

/** Archived and read-only channels share the public preview's lower notice.
 * Public previews offer Join; the admission role determines whether joining enables composition.
 * Confirmed membership can unmount this notice before its run settles, so the
 * page records the join intent when the run starts, not when it resolves. */
export function ChannelJoinNotice({
  channelId,
  ready = true,
  lifecycle,
  joinable,
  guest = false,
  archived = false,
  place = "channel",
  joinRole,
  onJoin,
  onHeightChange,
}: {
  channelId: string;
  ready?: boolean;
  lifecycle?: ChannelLifecycleCapability | undefined;
  joinable: boolean;
  guest?: boolean;
  archived?: boolean;
  place?: "chat" | "channel";
  joinRole?: "member" | "guest" | undefined;
  onJoin(): void;
  onHeightChange?(height: number): void;
}) {
  const notice = useRef<HTMLElement>(null);
  // Notices float above Join, not over it.
  useToastClearance(notice);
  const [revealedChannel, setRevealedChannel] = useState<string>();
  const visible = ready || revealedChannel === channelId;
  useEffect(() => {
    if (ready) setRevealedChannel(channelId);
  }, [ready, channelId]);
  useLayoutEffect(() => {
    const element = notice.current;
    if (!element || !onHeightChange) return;
    const measure = () =>
      onHeightChange(Math.ceil(element.getBoundingClientRect().height));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [onHeightChange]);
  const [state, setState] = useState<{ channelId: string; error?: string }>();
  const controller = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => controller.current?.abort(), []);
  const pending = state?.channelId === channelId && state.error === undefined;
  const error = state?.channelId === channelId ? state.error : undefined;
  const join = () => {
    if (!lifecycle || pending) return;
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setState({ channelId });
    onJoin();
    lifecycle.run("join", channelId, current.signal).then(
      () => {
        if (!current.signal.aborted) setState(undefined);
      },
      (reason: unknown) => {
        if (current.signal.aborted) return;
        setState({
          channelId,
          error:
            reason instanceof ChannelLifecycleUnconfirmed
              ? "Join may have taken effect, but it is not confirmed yet. Try again to check."
              : reason instanceof Error
                ? reason.message
                : `Couldn’t join this ${place}.`,
        });
      },
    );
  };
  const readOnly = guest || joinRole === "guest";
  const canJoin = !archived && !guest && joinable && !!lifecycle?.available;
  return (
    <section
      ref={notice}
      aria-label={
        archived
          ? `Archived ${place}`
          : readOnly
            ? `Read-only ${place}`
            : place === "chat"
              ? "Chat preview"
              : "Channel preview"
      }
      aria-hidden={!visible}
      inert={!visible}
      className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex justify-center p-3"
    >
      <div
        key={channelId}
        data-ready={visible}
        className={`${styles.channelJoinSurface} pointer-events-auto flex w-fit max-w-full flex-wrap items-center justify-center gap-2 p-1.5`}
      >
        <p className="max-w-md px-2 text-center text-body-sm text-subtle">
          {archived
            ? `This ${place} is archived`
            : readOnly
              ? joinRole === "guest"
                ? `This ${place} is read-only${canJoin ? ". Join to keep it in your sidebar and appear as a viewer." : ""}`
                : "Read-only access"
              : canJoin
                ? `Join ${place} to send messages`
                : `You’re previewing this ${place}`}
        </p>
        {canJoin && (
          <Button
            size="sm"
            variant="prominent"
            loading={pending}
            onClick={join}
          >
            Join
          </Button>
        )}
        {canJoin && error && (
          <p
            className="max-w-sm basis-full px-2 pb-1 text-body-sm text-danger"
            role="alert"
          >
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
