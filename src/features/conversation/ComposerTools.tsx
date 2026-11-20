import {
  memo,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { Contribution } from "../../plugins/contributions";
import type {
  ComposerTool,
  ComposerToolProps,
  ContributionReader,
  TargetOpener,
} from "./contracts";
import { ContributionBoundary, contributionKey } from "./ContributionBoundary";
import { useTargetOpener } from "./opener";

type HostToolProps = Omit<ComposerToolProps, keyof TargetOpener>;

export function ComposerTools({
  registry,
  renderLeading,
  ...props
}: HostToolProps & {
  registry: ContributionReader<ComposerTool>;
  /** Host layout for tools ordered before the default group; preserves DOM order. */
  renderLeading?: (tools: ReactNode) => ReactNode;
}) {
  const tools = useSyncExternalStore(
    registry.subscribe,
    registry.snapshot,
    registry.snapshot,
  );
  // Activation/re-enable order must not shuffle the visual or keyboard order.
  const order = (tool: ComposerTool) =>
    Number.isFinite(tool.order) ? (tool.order ?? 0) : 0;
  const sorted = [...tools].sort(
    (a, b) =>
      order(a) - order(b) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
  const render = (tool: Contribution<ComposerTool>) => (
    <ContributionBoundary
      key={contributionKey(tool)}
      fallback={<span role="status">{tool.title} unavailable</span>}
    >
      <OwnedTool tool={tool} registry={registry} {...props} />
    </ContributionBoundary>
  );
  if (!renderLeading) return sorted.map(render);
  return (
    <>
      {renderLeading(sorted.filter((tool) => order(tool) < 0).map(render))}
      {sorted.filter((tool) => order(tool) >= 0).map(render)}
    </>
  );
}
// Props are stable across keystrokes when the host passes stable commands.
const OwnedTool = memo(function OwnedTool({
  tool,
  registry,
  ...props
}: HostToolProps & {
  tool: Contribution<ComposerTool>;
  registry: ContributionReader<ComposerTool>;
}) {
  const current = useRef(props);
  useLayoutEffect(() => {
    current.current = props;
  });
  const [commands, setCommands] =
    useState<
      Pick<
        ComposerToolProps,
        | "insertText"
        | "insertMention"
        | "insertMentions"
        | "replaceRecipients"
        | "replaceRecipientsIfEmpty"
        | "insertResource"
        | "focus"
        | "capture"
      >
    >();
  useLayoutEffect(() => {
    let live = true;
    let release: (() => void) | undefined;
    const active = () =>
      live && registry.snapshot().includes(tool) && !current.current.disabled;
    setCommands({
      capture: (Capture) => {
        if (!active() || !current.current.capture) return false;
        const cancel = current.current.capture((props) => (
          <Capture
            {...props}
            accept={(recording) => active() && props.accept(recording)}
          />
        ));
        if (!cancel) return false;
        release = cancel;
        return () => {
          cancel();
          if (release === cancel) release = undefined;
        };
      },
      insertText: (text) =>
        active() ? current.current.insertText(text) : false,
      insertMention: (recipient) =>
        active() ? current.current.insertMention(recipient) : false,
      insertMentions: (recipients) =>
        active() ? current.current.insertMentions(recipients) : false,
      replaceRecipients: (recipients) =>
        active() ? current.current.replaceRecipients(recipients) : false,
      replaceRecipientsIfEmpty: (recipients) =>
        active()
          ? (current.current.replaceRecipientsIfEmpty?.(recipients) ?? false)
          : false,
      insertResource: (resource) =>
        active()
          ? current.current.insertResource(resource)
          : "The message can't be edited right now",
      focus: () => {
        if (active()) current.current.focus();
      },
    });
    return () => {
      live = false;
      release?.();
    };
  }, [tool, registry]);
  const opener = useTargetOpener(registry, tool);
  const Tool = tool.component;
  // A host that cannot attach withholds capture, so capture tools hide.
  if (!commands) return null;
  const { capture, ...rest } = commands;
  return (
    <Tool
      {...props}
      {...rest}
      {...(props.capture && capture ? { capture } : {})}
      {...opener}
    />
  );
});
