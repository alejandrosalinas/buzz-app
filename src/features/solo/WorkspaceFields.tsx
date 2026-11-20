import { useId, useRef, useEffect, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { FieldButton } from "../../shared/design-system/ui/FieldButton";
import { Input } from "../../shared/design-system/ui/Input";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import { Switch } from "../../shared/design-system/ui/Switch";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { PreferenceRow } from "../../shared/design-system/ui/PreferenceRow";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import {
  FolderPlusIcon,
  FolderSimpleIcon,
  XIcon,
} from "../../shared/design-system/icons";
import type { Workspace } from "./workspace";
import styles from "./WorkspaceSettings.module.css";

const MAX_FOLDERS = 20;
const folderName = (path: string) =>
  path
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .at(-1) || path;

export function WorkspaceFields({
  value,
  onChange,
  disabled = false,
  instructionRows = 5,
  instructionScope = "chat",
}: {
  value: Workspace;
  disabled?: boolean;
  /** Edit surfaces with room to spare give Instructions more visible lines. */
  instructionRows?: number;
  instructionScope?: "chat" | "workspace";
  onChange(value: Workspace): void;
}) {
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState("");
  const [typed, setTyped] = useState("");
  const folderErrorId = useId();
  const current = useRef({ value, onChange, disabled });
  current.current = { value, onChange, disabled };
  const alive = useRef(true);
  const add = useRef<HTMLElement>(null);
  const pathInput = useRef<HTMLInputElement>(null);
  const location = useRef<HTMLElement>(null);
  const removes = useRef<(HTMLElement | null)[]>([]);
  const focusAfter = useRef<number | "add" | "location" | undefined>(undefined);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const folders = value.folders.map((path) => path.trim()).filter(Boolean);
  useEffect(() => {
    const target = focusAfter.current;
    focusAfter.current = undefined;
    if (target === undefined) return;
    const requested =
      target === "add"
        ? add.current
        : target === "location"
          ? location.current
          : removes.current[target];
    [requested, pathInput.current, removes.current.at(-1), location.current]
      .find((node) => node && !node.matches(":disabled, [data-disabled]"))
      ?.focus();
  });
  /** Appends a folder; returns false when it was not added. */
  const attach = (path: string) => {
    if (current.current.disabled) return false;
    const latest = current.current.value;
    const existing = latest.folders.map((item) => item.trim()).filter(Boolean);
    const next = path.trim();
    if (!next) return false;
    if (existing.includes(next)) {
      setError("Already added.");
      return false;
    }
    if (existing.length >= MAX_FOLDERS) return false;
    setError("");
    current.current.onChange({ ...latest, folders: [...existing, next] });
    return true;
  };
  const browse = async () => {
    setPicking(true);
    setError("");
    try {
      const path = await invoke<string | null>("workspace_pick_folder", {
        title: "Add a folder",
      });
      if (alive.current && path) attach(path);
    } catch (reason) {
      if (alive.current)
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (alive.current) {
        setPicking(false);
        focusAfter.current = "add";
      }
    }
  };
  const pickLocation = async () => {
    setPicking(true);
    setError("");
    try {
      const path = await invoke<string | null>("workspace_pick_folder", {
        title: "Choose a worktree location",
        start: current.current.value.worktree?.location,
      });
      const latest = current.current.value;
      if (alive.current && !current.current.disabled && path && latest.worktree)
        current.current.onChange({
          ...latest,
          worktree: { ...latest.worktree, location: path },
        });
    } catch (reason) {
      if (alive.current)
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (alive.current) {
        setPicking(false);
        focusAfter.current = "location";
      }
    }
  };
  const remove = (index: number) => {
    const next = folders.filter((_, item) => item !== index);
    focusAfter.current = next.length ? Math.min(index, next.length - 1) : "add";
    setError("");
    onChange({ ...value, folders: next });
  };
  const full = folders.length >= MAX_FOLDERS;
  const worktree = value.worktree;
  const folderError =
    error ||
    (worktree && !folders.length
      ? "Add at least one folder to use a new worktree."
      : undefined);
  return (
    <div className={styles.sections}>
      <Field label="Instructions" optional>
        <Textarea
          disabled={disabled}
          rows={instructionRows}
          value={value.canvas}
          onChange={(event) =>
            onChange({ ...value, canvas: event.target.value })
          }
          placeholder={`Instructions and context for agents working in this ${instructionScope}.`}
        />
      </Field>
      <div className={styles.fields}>
        <Field
          label="Folders"
          optional={!worktree}
          nativeLabel={false}
          description={full ? "Up to 20 folders." : undefined}
          error={
            folderError ? (
              <span id={folderErrorId}>{folderError}</span>
            ) : undefined
          }
        >
          {folders.length > 0 && (
            <div className={styles.folderList}>
              <SettingsGroup layout="cards">
                {folders.map((folder, index) => (
                  <PreferenceRow
                    key={folder}
                    icon={<FolderSimpleIcon size={18} />}
                    title={folderName(folder)}
                    subtitle={folder}
                    trailing={
                      <IconButton
                        ref={(node) => {
                          removes.current[index] = node;
                        }}
                        disabled={disabled}
                        variant="ghost"
                        size="sm"
                        aria-label={`Remove ${folderName(folder)}`}
                        icon={<XIcon size={16} />}
                        onClick={() => remove(index)}
                      />
                    }
                  />
                ))}
              </SettingsGroup>
            </div>
          )}
          {isTauri() ? (
            <div>
              <Button
                ref={add}
                variant="outline"
                size="sm"
                disabled={disabled || full || picking}
                loading={picking}
                aria-describedby={folderError ? folderErrorId : undefined}
                onClick={() => void browse()}
              >
                <FolderPlusIcon size={16} aria-hidden="true" />
                Add folder…
              </Button>
            </div>
          ) : (
            <div className={styles.repositoryInput}>
              <Input
                ref={pathInput}
                aria-label="Folder path"
                value={typed}
                disabled={disabled || full}
                placeholder="~/Development/my-project"
                onChange={(event) => setTyped(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  if (attach(typed)) setTyped("");
                }}
              />
              <Button
                ref={add}
                shape="control"
                disabled={disabled || full || !typed.trim()}
                onClick={() => {
                  if (attach(typed)) setTyped("");
                }}
              >
                Add
              </Button>
            </div>
          )}
        </Field>
        <Switch
          disabled={disabled}
          label="Work in a new worktree"
          checked={!!worktree}
          onCheckedChange={(checked) =>
            onChange({
              ...value,
              worktree: checked
                ? { location: "~/.buzz/worktrees", baseBranch: "main" }
                : undefined,
            })
          }
        />
        {worktree && (
          <div className={styles.worktree}>
            {isTauri() ? (
              <Field label="Worktree location" nativeLabel={false}>
                <FieldButton
                  ref={location}
                  dropdown={false}
                  title={worktree.location}
                  aria-label={`Worktree location: ${worktree.location}`}
                  disabled={disabled || picking}
                  onClick={() => void pickLocation()}
                >
                  {worktree.location}
                </FieldButton>
              </Field>
            ) : (
              <Field label="Worktree location">
                <Input
                  disabled={disabled}
                  value={worktree.location}
                  onChange={(event) =>
                    onChange({
                      ...value,
                      worktree: { ...worktree, location: event.target.value },
                    })
                  }
                />
              </Field>
            )}
            <Field label="Base branch">
              <Input
                disabled={disabled}
                value={worktree.baseBranch}
                onChange={(event) =>
                  onChange({
                    ...value,
                    worktree: { ...worktree, baseBranch: event.target.value },
                  })
                }
              />
            </Field>
          </div>
        )}
      </div>
    </div>
  );
}
