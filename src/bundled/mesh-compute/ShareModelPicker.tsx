import { invoke } from "@tauri-apps/api/core";
import { type ReactNode, useEffect, useId, useState } from "react";
import {
  CheckIcon,
  DownloadIcon,
  CpuIcon,
  MonitorIcon,
  RobotIcon,
} from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { Input } from "../../shared/design-system/ui/Input";
import { Select } from "../../shared/design-system/ui/Select";
import styles from "./Compute.module.css";

type Catalog = {
  gpuName: string | null;
  vramDisplay: string;
  recommended: string | null;
  entries: {
    model: string;
    name: string;
    size: string | null;
    installed: boolean;
    curated: boolean;
    fit: string;
  }[];
};
const CUSTOM = "__custom__";
const AUTO = "__auto__";
const FIT_LABELS: Record<string, string> = {
  comfortable: "fits comfortably",
  tight: "fits, tight on memory",
  tradeoff: "may be slow on this machine",
  too_large: "too large for this machine",
};

export function ShareModelPicker({
  model,
  onChange,
  disabled,
  auto,
  onReset,
  resetDisabled,
  onRecommendation,
  onModelNames,
  runningModel,
  children,
  activity,
}: {
  children?: ReactNode;
  activity?: ReactNode;
  model: string;
  onChange: (model: string) => void;
  disabled: boolean;
  auto: boolean;
  onReset: () => void;
  onRecommendation?: (model: string | null) => void;
  /** Friendly catalog names keyed by exact model reference. */
  onModelNames?: (names: Record<string, string>) => void;
  runningModel?: string | null;
  resetDisabled?: boolean;
}) {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [custom, setCustom] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const id = useId();
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt explicitly retries the catalog read.
  useEffect(() => {
    let active = true;
    setError(null);
    const deadline = setTimeout(() => {
      if (active) {
        active = false;
        setError(
          "Model choices took too long to load. Retry, or choose a custom model.",
        );
      }
    }, 30000);
    void invoke<Catalog>("mesh_compute_catalog")
      .then((result) => {
        if (!Array.isArray(result.entries))
          throw new Error("Invalid Mesh model catalog");
        if (active) {
          clearTimeout(deadline);
          setCatalog(result);
        }
      })
      .catch((error) => {
        if (active) {
          clearTimeout(deadline);
          setError(String(error));
        }
      });
    return () => {
      clearTimeout(deadline);
      active = false;
    };
  }, [attempt]);
  useEffect(() => {
    onRecommendation?.(catalog?.recommended ?? null);
  }, [catalog?.recommended, onRecommendation]);
  useEffect(() => {
    if (catalog)
      onModelNames?.(
        Object.fromEntries(catalog.entries.map((e) => [e.model, e.name])),
      );
  }, [catalog, onModelNames]);
  const displayModel = auto
    ? (catalog?.recommended ?? runningModel ?? model)
    : model;
  const entry = catalog?.entries.find((entry) => entry.model === displayModel);
  return (
    <div>
      <div className={styles.deviceOverview}>
        {activity}
        <dl className={styles.deviceTiles}>
          <div className={styles.deviceTile}>
            <dt>
              <MonitorIcon size={18} /> Hardware
            </dt>
            <dd>{catalog?.gpuName ?? "—"}</dd>
          </div>
          <div className={styles.deviceTile}>
            <dt>
              <CpuIcon size={18} /> AI memory{" "}
            </dt>
            <dd className={styles.memoryValue}>
              <span
                className={styles.fit}
                data-fit={entry?.fit}
                title={entry ? fitLabel(entry.fit) : undefined}
              >
                {catalog?.vramDisplay ?? "—"}
              </span>
              {entry?.fit === "too_large" && (
                <span
                  className={`${styles.headerStatus} ${styles.fit}`}
                  data-fit={entry.fit}
                >
                  Too large
                </span>
              )}
            </dd>
          </div>
          <div className={`${styles.deviceTile} ${styles.modelTile}`}>
            <dt>
              <RobotIcon size={18} /> Model{" "}
              <span className={styles.headerStatus}>
                {entry && (
                  <span>
                    <span
                      className={styles.statusBadge}
                      title={
                        entry.installed
                          ? "GGUF cached; additional serving files may download"
                          : "Downloads when sharing starts"
                      }
                    >
                      {entry.installed ? (
                        <CheckIcon size={14} />
                      ) : (
                        <DownloadIcon size={14} />
                      )}
                      {entry.installed
                        ? "Cached"
                        : `Download ${entry.size ?? "required"}`}
                    </span>
                  </span>
                )}
              </span>
            </dt>
            <dd className={styles.modelChoice}>
              <Select
                label="Model to share"
                variant="compact"
                value={auto ? AUTO : custom ? CUSTOM : displayModel}
                valueLabel={
                  auto
                    ? "Auto"
                    : (entry?.name ?? (displayModel || "Select model"))
                }
                valueTitle={displayModel || "Automatic model selection"}
                disabled={disabled && (resetDisabled ?? disabled)}
                onValueChange={(value) => {
                  setCustom(value === CUSTOM);
                  if (value === AUTO) onReset();
                  else onChange(value === CUSTOM ? "" : value);
                }}
                groups={[
                  {
                    label: "",
                    options: [
                      {
                        value: AUTO,
                        label: "Auto",
                        disabled: resetDisabled ?? disabled,
                      },
                    ],
                  },
                  {
                    label: "Recommended and curated",
                    options: (catalog?.entries ?? [])
                      .filter((entry) => entry.curated)
                      .map((entry) => ({
                        value: entry.model,
                        label: `${entry.name}${entry.model === catalog?.recommended ? " — recommended" : ""}${optionDetail(entry)}`,
                        disabled: disabled || tooLarge(entry, displayModel),
                      })),
                  },
                  {
                    label: "Other models",
                    options: [
                      ...(!custom && !auto && displayModel && !entry
                        ? [
                            {
                              value: displayModel,
                              label: displayModel,
                              disabled,
                            },
                          ]
                        : []),
                      ...(catalog?.entries ?? [])
                        .filter((entry) => !entry.curated)
                        .map((entry) => ({
                          value: entry.model,
                          label: `${entry.name}${optionDetail(entry)}`,
                          disabled: disabled || tooLarge(entry, displayModel),
                        })),
                      {
                        value: CUSTOM,
                        label: "Custom model or local GGUF",
                        disabled,
                      },
                    ],
                  },
                ]}
              />
              {custom && (
                <label htmlFor={id} className="text-body-sm">
                  Model reference or local GGUF path
                  <Input
                    id={id}
                    value={model}
                    onChange={(event) => onChange(event.target.value)}
                    disabled={disabled}
                  />
                </label>
              )}
            </dd>
          </div>
        </dl>
      </div>
      {error ? (
        <p role="alert">
          {error}{" "}
          <Button disabled={disabled} onClick={() => setAttempt(attempt + 1)}>
            Retry model catalog
          </Button>
        </p>
      ) : (
        !catalog && (
          <p role="status" className="sr-only">
            Loading model choices…
          </p>
        )
      )}
      {auto &&
        runningModel &&
        catalog?.recommended &&
        runningModel !== catalog.recommended && (
          <p className="text-body-sm text-secondary">
            Auto selection applies next time sharing starts.
          </p>
        )}
      {children}
    </div>
  );
}

const fitLabel = (fit: string) => FIT_LABELS[fit] ?? fit.replaceAll("_", " ");

function optionDetail(entry: Catalog["entries"][number]): string {
  return `${entry.size ? ` · ${entry.size}` : ""}${entry.installed ? " · installed" : " · download"}${entry.fit === "unknown" ? "" : ` · ${fitLabel(entry.fit)}`}`;
}

/** A model this machine can't hold is not offered, unless it's already chosen. */
const tooLarge = (entry: Catalog["entries"][number], selected: string) =>
  entry.fit === "too_large" && entry.model !== selected;
