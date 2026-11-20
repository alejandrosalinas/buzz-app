import {
  memo,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { Contribution } from "../../plugins/contributions";
import type {
  ComposerAccessory,
  ComposerAccessoryProps,
  ContributionReader,
} from "./contracts";
import { ContributionBoundary, contributionKey } from "./ContributionBoundary";

export function ComposerAccessories({
  registry,
  placement,
  ...props
}: ComposerAccessoryProps & {
  registry: ContributionReader<ComposerAccessory>;
  placement?: ComposerAccessory["placement"];
}) {
  const entries = useSyncExternalStore(
    registry.subscribe,
    registry.snapshot,
    registry.snapshot,
  );
  const order = (entry: ComposerAccessory) =>
    Number.isFinite(entry.order) ? (entry.order ?? 0) : 0;
  const ordered = entries
    .filter(
      (entry) =>
        (entry.placement ?? "composer") ===
        (placement ?? (props.message ? "message" : "composer")),
    )
    .sort(
      (a, b) =>
        order(a) - order(b) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    );
  const decorator = props.renderMessageSummary
    ? ordered.find((entry) => entry.decoratesMessageSummary)
    : undefined;
  return (
    <>
      {!decorator && props.renderMessageSummary?.()}
      {ordered.map((entry) => (
        <ContributionBoundary
          key={`${contributionKey(entry)}:${props.scope}:${props.channelId}:${props.message?.id ?? props.threadRootId ?? ""}`}
          fallback={
            <>
              {entry === decorator && props.renderMessageSummary?.()}
              <p role="status">{entry.title} unavailable</p>
            </>
          }
        >
          <OwnedAccessory
            entry={entry}
            registry={registry}
            {...props}
            renderMessageSummary={
              entry === decorator ? props.renderMessageSummary : undefined
            }
          />
        </ContributionBoundary>
      ))}
    </>
  );
}
const OwnedAccessory = memo(function OwnedAccessory({
  entry,
  registry,
  ...props
}: ComposerAccessoryProps & {
  entry: Contribution<ComposerAccessory>;
  registry: ContributionReader<ComposerAccessory>;
}) {
  const current = useRef(props);
  useLayoutEffect(() => {
    current.current = props;
  });
  const canOpenThread = !!props.openThread;
  const [commands, setCommands] =
    useState<
      Pick<ComposerAccessoryProps, "open" | "openThread" | "onFocusedRemoval">
    >();
  useLayoutEffect(() => {
    let live = true;
    const session = props.session;
    const active = () =>
      live &&
      registry.snapshot().includes(entry) &&
      current.current.session === session;
    setCommands({
      open: (target) => active() && current.current.open(target),
      onFocusedRemoval: () => {
        if (active()) current.current.onFocusedRemoval?.();
      },
      openThread: canOpenThread
        ? () => active() && (current.current.openThread?.() ?? false)
        : undefined,
    });
    return () => {
      live = false;
    };
  }, [entry, registry, props.session, canOpenThread]);
  // Availability is read during render, so it follows this render's host;
  // dispatch goes through the committed one. Both end when this mount retires.
  const retired = useRef(false);
  useLayoutEffect(() => {
    retired.current = false;
    return () => {
      retired.current = true;
    };
  }, []);
  const hostCanOpen = props.canOpen;
  const canOpen = useMemo(
    () => (target: string) =>
      !retired.current &&
      registry.snapshot().includes(entry) &&
      hostCanOpen(target),
    [registry, entry, hostCanOpen],
  );
  const Accessory = entry.component;
  return commands ? (
    <Accessory {...props} {...commands} canOpen={canOpen} />
  ) : (
    (props.renderMessageSummary?.() ?? null)
  );
});
