import { useSyncExternalStore } from "react";
import type { PluginModule } from "../../plugins/api";
import type { RelaySession } from "../../features/relay/session";
import type { Reminder, Reminders } from "../../features/relay/reminders";
import type { OpenTarget } from "../../features/navigation/targets";
import { plainText } from "../../features/notifications/content";
import { CountBadge } from "../../shared/design-system/ui/CountBadge";
import { AlarmIcon } from "../../shared/design-system/icons/index";
import {
  countDue,
  dueSince,
  navigableTarget,
  nextDelay,
  nowSeconds,
  pendingMessageIds,
} from "./model";
import { RemindDialog } from "./RemindDialog";
import { RemindersPage } from "./RemindersPage";
import styles from "./Reminders.module.css";
import { noState, noSubscribe, scopeOf, useReminders } from "./react";

export const inject = [
  "pages",
  "relay",
  "navigation",
  "conversation",
  "notifications",
];

// The last check time per `<origin>:<viewer>`, so reminders that came due
// while the app was closed notify on the next launch.
const CHECKED_KEY = "buzz-reminders-checked.v1";
/** Labels change by the minute, so half a minute keeps them current. */
const PAGE_TICK_MS = 30_000;
const storage = () =>
  typeof localStorage === "undefined" ? undefined : localStorage;
function readChecked(scope: string) {
  try {
    const raw = storage()?.getItem(`${CHECKED_KEY}:${scope}`);
    return raw && /^\d{1,12}$/.test(raw) ? Number(raw) : undefined;
  } catch {
    return undefined;
  }
}
function writeChecked(scope: string, at: number) {
  try {
    storage()?.setItem(`${CHECKED_KEY}:${scope}`, String(at));
  } catch {
    // The in-memory time still prevents repeats while this window runs.
  }
}

export const apply: PluginModule["apply"] = (ctx) => {
  const relay = ctx.relay;
  // Checks, and a tick while the page is open, advance `now` for the badge and
  // page.
  let now = nowSeconds();
  const clock = new Set<() => void>();
  const subscribeClock = (listener: () => void) => {
    clock.add(listener);
    return () => void clock.delete(listener);
  };
  const readClock = () => now;
  const tick = () => {
    now = nowSeconds();
    for (const listener of clock) listener();
  };
  // The page's relative due and done labels age without a due-time event, so
  // the clock also ticks while the page is open.
  const subscribePageClock = (listener: () => void) => {
    const off = subscribeClock(listener);
    const timer = setInterval(tick, PAGE_TICK_MS);
    return () => {
      clearInterval(timer);
      off();
    };
  };
  const notify = ctx.notifications.register({
    id: "reminders",
    label: "Reminders",
  });
  const page = { pluginId: "buzz.reminders", pageId: "reminders" };

  ctx.effect(() => {
    // Per community, across sessions: reminders due at or before the baseline
    // (the saved time when first bound) stay on the page; any later due time
    // notifies once, however late its reminder arrives. `notified` holds the
    // keys shown since the baseline.
    const baselines = new Map<string, number>();
    const notified = new Map<string, Set<string>>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let bound: Reminders | undefined;
    let boundScope = "";
    let unbind: (() => void) | undefined;
    const check = () => {
      clearTimeout(timer);
      tick();
      const connection = relay.snapshot();
      // Only the session this window was bound for may advance it.
      if (
        !bound ||
        connection.status !== "ready" ||
        connection.session.reminders !== bound
      )
        return;
      const { hydrated, reminders } = bound.snapshot();
      // Nothing notifies before the first page of a history read lands; later
      // pages notify as they arrive, and the saved time below waits for `ready`.
      if (!hydrated) return;
      // Notification access is judged against the channel list, so hold the
      // window until a full roster read has verified it rather than spend it
      // on refusals for channels that are not listed yet.
      const list = connection.session.channels.list();
      if (
        list.status !== "ready" ||
        connection.session.live.snapshot().roster.state !== "verified"
      )
        return;
      const scope = scopeOf(connection);
      const baseline = baselines.get(boundScope) ?? now;
      const shown = notified.get(boundScope) ?? new Set<string>();
      notified.set(boundScope, shown);
      const keyOf = (reminder: Reminder) =>
        `${reminder.id}:${reminder.notBefore}`;
      // Every reminder notification opens in the community it came from.
      if (scope) {
        const { channels } = list;
        const home: OpenTarget = { version: 1, kind: "page", ...page, scope };
        for (const reminder of dueSince(reminders, baseline, now)) {
          const sourceKey = keyOf(reminder);
          if (shown.has(sourceKey)) continue;
          shown.add(sourceKey);
          const message = navigableTarget(reminder);
          const channel =
            message && channels.find((item) => item.id === message.channelId);
          const target: OpenTarget = message
            ? {
                version: 1,
                kind: "conversation",
                scope,
                channelId: message.channelId,
                messageId: message.eventId,
              }
            : home;
          const alert = (to: OpenTarget) =>
            notify.submit({
              sourceKey,
              target: to,
              title:
                channel && channel.channelType !== "dm" && channel.name
                  ? `Reminder due · #${channel.name}`
                  : "Reminder due",
              body:
                [
                  plainText(reminder.target?.preview ?? "", {
                    storedPreview: true,
                  }),
                  plainText(reminder.note ?? ""),
                ].find(Boolean) || "A reminder is waiting",
            });
          // Access refuses the message when the viewer isn't in its channel, so
          // that reminder opens Reminders instead of never alerting. The retry
          // follows any refusal, so it relies on every other one refusing the
          // page too: a closed service, a missing or different viewer, a stale
          // category, the `seen` key (it ignores the target kind), the pending
          // cap, the development pause, alerts or this category off, and the
          // Focus gate; denied permission drops both at delivery. So a page
          // alert appears only when access refused the message. A future gate
          // that allows pages but blocks conversations would be routed around.
          void alert(target)
            .then((admitted) => admitted || !message || alert(home))
            .catch(() => {});
        }
      }
      // The saved time is what the next launch treats as seen, so it moves only
      // while the live connection is up and the latest read started during that
      // connection, succeeded, and has none pending (`ready`), or the list was
      // complete at the drop and this connection's continuous replay carried
      // every edit since. Reads made before the first connection, or before or
      // during an outage, never count, since live events could not reach them.
      // Limit: a reminder decoded after the saved time passed its due time
      // still notifies this session via `notified`, but is lost if the app
      // quits before then.
      const read = bound.snapshot();
      if (
        read.status === "ready" &&
        read.error === undefined &&
        connection.session.live.snapshot().status === "connected"
      ) {
        writeChecked(boundScope, now);
      }
      // After sleep the timer fires late; the baseline still covers the gap.
      const delay = nextDelay(reminders, now);
      if (delay !== undefined) timer = setTimeout(check, delay);
    };
    const bind = () => {
      const connection = relay.snapshot();
      const next =
        connection.status === "ready"
          ? connection.session.reminders
          : undefined;
      if (next !== bound) {
        unbind?.();
        bound = next;
        boundScope = connection.scope ?? "";
        if (next && !baselines.has(boundScope)) {
          const checked = readChecked(boundScope) ?? nowSeconds();
          baselines.set(boundScope, checked);
          writeChecked(boundScope, checked);
        }
        const offReminders = next?.subscribe(check);
        const offLive =
          next && connection.status === "ready"
            ? connection.session.live.subscribe(check)
            : undefined;
        unbind = () => {
          offReminders?.();
          offLive?.();
        };
        void next?.refresh();
        check();
      }
    };
    const stop = relay.subscribe(bind);
    bind();
    return () => {
      stop();
      unbind?.();
      clearTimeout(timer);
    };
  });

  function Badge() {
    const { state } = useReminders(relay);
    const at = useSyncExternalStore(subscribeClock, readClock, readClock);
    const due = countDue(state.reminders, at);
    return <CountBadge count={due} label={`${due} due`} />;
  }

  ctx.pages.register({
    id: "reminders",
    title: "Reminders",
    layout: "workspace",
    primary: true,
    badge: Badge,
    component: () => (
      <RemindersPage
        relay={relay}
        navigator={ctx.navigation}
        clock={{ subscribe: subscribePageClock, read: readClock }}
      />
    ),
  });

  function Marker({
    message,
    session,
  }: {
    message: { id: string };
    session: RelaySession;
  }) {
    const reminders = session.reminders;
    const state = useSyncExternalStore(
      reminders?.subscribe ?? noSubscribe,
      reminders?.snapshot ?? noState,
      reminders?.snapshot ?? noState,
    );
    return pendingMessageIds(state).has(message.id) ? (
      <span
        className={styles.marker}
        role="img"
        title="Reminder set"
        aria-label="Reminder set"
      >
        <AlarmIcon size={14} aria-hidden="true" />
      </span>
    ) : null;
  }

  ctx.conversation.registerMessageAction({
    id: "remind-me",
    title: "Remind me",
    icon: () => <AlarmIcon size={16} aria-hidden="true" />,
    matches: (_message, session) => !!session.reminders,
    component: RemindDialog,
    marker: Marker,
  });
};
