// "AI setup": Automatic or Custom, as one Settings row whose
// Custom rows open in place under it. Create agent and an agent's Identity
// settings share it. The recommendation names its source when supplied.
import { type ComponentType, type ReactNode, useEffect, useState } from "react";
import styles from "./AISettings.module.css";
import { SettingsAiIcon } from "../../shared/design-system/icons";
import { PreferenceRow } from "../../shared/design-system/ui/PreferenceRow";
import { Select } from "../../shared/design-system/ui/Select";
import { SettingsGroupExpand } from "../../shared/design-system/ui/SettingsGroup";
import { type RecommendedCandidate, recommendedSetup } from "./recommended";

const effortLabel = (effort: string) =>
  effort === "xhigh"
    ? "Extra high"
    : `${effort.charAt(0).toUpperCase()}${effort.slice(1)}`;

type Mark = ComponentType<{ size?: number | string }> | undefined;

/** Shared decorative mode/harness mark for settings and agent cards. */
export function AISettingsIcon({
  automatic,
  harnessIcon: HarnessIcon,
  compact = false,
}: {
  automatic: boolean;
  harnessIcon?: Mark;
  compact?: boolean;
}) {
  const [visible, setVisible] = useState(() => !document.hidden);
  useEffect(() => {
    const update = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return HarnessIcon ? (
    <span
      className={`inline-grid shrink-0 ${compact ? "size-4.5" : "size-5"} ${styles.mark}`}
      data-cycling={automatic && visible}
      aria-hidden="true"
    >
      <span className={styles.ai}>
        <SettingsAiIcon size={compact ? 18 : 20} />
      </span>
      <span className={styles.harness}>
        <HarnessIcon size={compact ? 18 : 20} />
      </span>
    </span>
  ) : (
    <SettingsAiIcon size={compact ? 18 : 20} aria-hidden="true" />
  );
}

/** What Automatic picked, with a plain explanation when it skipped a harness.
 * This sits inside a Select option, so it contains no interactive controls. */
export function UsesLine({
  icon: Icon,
  title,
  candidate,
  skipped,
}: Readonly<{
  icon: Mark;
  /** The harness's name, read with the value by assistive technology. */
  title: string;
  candidate: Pick<RecommendedCandidate, "label" | "effort">;
  /** The usual pick's harness, when it isn't set up here. */
  skipped?: string | undefined;
}>) {
  const value = `${candidate.label} · ${effortLabel(candidate.effort)}`;
  return (
    <span>
      <span className="text-caption text-subtle">
        {Icon && (
          <span className="inline-flex align-baseline" aria-hidden="true">
            <Icon size={12} />
          </span>
        )}
        <span className="sr-only">{title}:</span>{" "}
        <span title={value}>{value}</span>
      </span>
      {skipped && (
        <>
          {" "}
          <span className="mt-1 block text-body-sm">
            {`Buzz’s usual pick, ${skipped}, isn’t set up on this computer, so this agent uses ${candidate.label}.`}
          </span>
        </>
      )}
    </span>
  );
}

/** "Checking this computer…", held back a second so a quick check doesn't
 * flash it; until then a blank line as tall as the result. */
export function Checking() {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setShown(true), 1000);
    return () => clearTimeout(timer);
  }, []);
  return (
    <span className="buzz-uses-line inline-flex items-center">
      {shown ? "Checking this computer…" : "\u00a0"}
    </span>
  );
}

/** Keep pending/default status visible; settled model details belong in the menu. */
export function runsOnDetails(
  type: Readonly<{ title: string; icon?: Mark }>,
  resolved: RecommendedCandidate | null | undefined,
) {
  if (resolved === undefined) return { summary: <Checking /> };
  if (resolved) {
    return {
      modelName: resolved.label,
      model: (
        <UsesLine icon={type.icon} title={type.title} candidate={resolved} />
      ),
    };
  }
  return {
    summary: `No recommended model is available, so this uses ${type.title}’s default.`,
  };
}

export function AISettings({
  automatic,
  harnessIcon: HarnessIcon,
  modelName,
  model,
  summary,
  action,
  automaticHint,
  manualHint = "Choose your own settings.",
  disabled = false,
  onChange,
  children,
}: Readonly<{
  automatic: boolean;
  harnessIcon?: Mark;
  /** The selected model's display name; absent while it is being resolved. */
  modelName?: string | undefined;
  /** Settled model details shown in Automatic's menu option. */
  model?: ReactNode;
  /** Pending, unavailable or error status, kept visible in the closed row. */
  summary?: ReactNode;
  /** A next step after the summary, such as a link, outside its live region. */
  action?: ReactNode;
  /** What Automatic means, in its menu. */
  automaticHint?: string;
  manualHint?: string;
  disabled?: boolean;
  onChange(automatic: boolean): void;
  /** The custom rows, opened in place while Custom is selected. */
  children: ReactNode;
}>) {
  const { recommendedBy, description: configuredDescription } =
    recommendedSetup();
  const description =
    [
      recommendedBy && `Recommended by ${recommendedBy}.`,
      automaticHint ?? configuredDescription,
    ]
      .filter(Boolean)
      .join(" ") || "Use recommended settings.";
  return (
    <>
      <PreferenceRow
        icon={
          <AISettingsIcon automatic={automatic} harnessIcon={HarnessIcon} />
        }
        title="AI setup"
        // One lasting live region, announced as it changes (from checking to
        // available); a link or button in `action` stays outside it.
        subtitle={
          <span className="grid min-w-0 gap-1">
            {automatic && modelName && (
              <span
                className="flex min-w-0 items-baseline gap-1"
                title={`Set to ${modelName} (recommended)`}
              >
                <span className="shrink-0">Set to</span>{" "}
                <span className="truncate">{modelName}</span>{" "}
                <span className="shrink-0"> (recommended)</span>
              </span>
            )}
            <span
              role="status"
              className={automatic && summary ? undefined : "sr-only"}
            >
              {automatic && summary}
            </span>
            {automatic && action && <span>{action}</span>}
          </span>
        }
        trailing={(control) => (
          <Select
            describedBy={control["aria-describedby"]}
            label="AI setup"
            variant="compact"
            align="end"
            value={automatic ? "automatic" : "manual"}
            disabled={disabled}
            groups={[
              {
                label: "",
                options: [
                  {
                    value: "automatic",
                    label: "Automatic",
                    description: (
                      <span className="grid gap-1.5 text-caption">
                        {description && (
                          <span className="text-body-sm">{description}</span>
                        )}
                        {model && (
                          <>
                            {" "}
                            <span className="text-subtle">{model}</span>
                          </>
                        )}
                      </span>
                    ),
                  },
                  {
                    value: "manual",
                    label: "Custom",
                    description: manualHint,
                  },
                ],
              },
            ]}
            onValueChange={(value) => onChange(value === "automatic")}
          />
        )}
      />
      <SettingsGroupExpand open={!automatic}>{children}</SettingsGroupExpand>
    </>
  );
}
