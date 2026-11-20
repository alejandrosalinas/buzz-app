import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RelaySession } from "../../features/relay/session";

type MuteIntent = Readonly<{
  channelId: string;
  name: string;
  muted: boolean;
  pending: boolean;
  error?: string;
}>;

/** Presentation only: notifications continue to use confirmed session preferences. */
export function useOptimisticMute(
  write: RelaySession["sidebarPreferences"]["setMute"],
) {
  const [intents, setIntents] = useState<ReadonlyMap<string, MuteIntent>>(
    new Map(),
  );
  const lifetime = useRef<{
    live: boolean;
    write: typeof write;
  } | null>(null);
  useEffect(() => {
    const view = { live: true, write };
    lifetime.current = view;
    setIntents(new Map());
    return () => {
      view.live = false;
      lifetime.current = null;
    };
  }, [write]);

  /** `onSaved` runs once this change is saved, and never when it fails. */
  const change = useCallback(function change(
    channelId: string,
    name: string,
    muted: boolean,
    onSaved?: () => void,
  ) {
    const active = lifetime.current;
    if (!active) return;
    const intent: MuteIntent = { channelId, name, muted, pending: true };
    setIntents((current) => new Map(current).set(channelId, intent));
    const finish = (error?: string) => {
      if (!active.live) return;
      setIntents((current) => {
        // An older completion must not remove or roll back a newer click.
        if (current.get(channelId) !== intent) return current;
        const next = new Map(current);
        if (error !== undefined)
          next.set(channelId, { ...intent, pending: false, error });
        else next.delete(channelId);
        return next;
      });
    };
    void (async () => {
      try {
        // The session owns saving; leaving Messages must not cancel the intent.
        await active.write(channelId, muted);
      } catch (error) {
        finish(error instanceof Error ? error.message : String(error));
        return;
      }
      finish();
      onSaved?.();
    })();
  }, []);
  const dismiss = useCallback((channelId: string) => {
    setIntents((current) => {
      if (current.get(channelId)?.pending) return current;
      const next = new Map(current);
      next.delete(channelId);
      return next;
    });
  }, []);
  return useMemo(
    () => ({ intents, change, dismiss }),
    [intents, change, dismiss],
  );
}
