import { useEffect, useMemo, useState } from "react";
import type { PanelProps } from "../../features/panels/service";
import {
  CaretLeftIcon,
  CaretRightIcon,
} from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { LoadingRegion } from "../../shared/design-system/ui/LoadingRegion";
import { Select } from "../../shared/design-system/ui/Select";
import { DiffViewer } from "../diffs/DiffViewer";
import { parsePatch } from "../diffs/parse";
import type { ChangedFile } from "./git";
import { parseTarget } from "./target";
import type { Turns } from "./turns";
import { Counts, plural, totals } from "./Counts";
import styles from "./Changesets.module.css";
import { useLoaded } from "./useLoaded";

/** A recorded turn's checkout: its files, one diff at a time. */
export function ChangesetPanel({
  target,
  turns,
}: Pick<PanelProps, "target"> & { turns: Turns }) {
  const link = useMemo(() => parseTarget(target), [target]);
  const found = link && turns.find(link.turn, link.checkout);
  const [chosen, setChosen] = useState(link?.file);
  useEffect(() => setChosen(link?.file), [link?.file]);
  const listed = useLoaded(
    link ? () => turns.summary(link.turn, link.checkout) : undefined,
    [turns, link],
  );
  const files = listed.value;
  const index = files
    ? Math.max(
        0,
        files.findIndex((each) => each.path === chosen),
      )
    : 0;
  const file = files?.[index];
  const patch = useLoaded(
    link && file && !file.binary
      ? () => turns.patch(link.turn, link.checkout, file)
      : undefined,
    [turns, link, file],
  );
  const parsed = useMemo(
    () => (patch.value === undefined ? undefined : parsePatch(patch.value)),
    [patch.value],
  );
  if (!link || !found)
    return <p role="alert">This changeset was recorded in another Buzz.</p>;
  const pending = listed.error === undefined && !files;
  const step = (by: number) => files && setChosen(files[index + by]?.path);
  return (
    <div className={styles.panel}>
      <InlineHeader
        level={3}
        title={found.checkout.label}
        subtitle={
          files ? (
            <>
              {plural(files.length, "file")} changed{" "}
              <Counts {...totals(files)} />
            </>
          ) : undefined
        }
      />
      <LoadingRegion
        pending={pending}
        label="Reading the changes…"
        statusVisibility="screen-reader"
        feedback={
          listed.error !== undefined ? (
            <div role="alert">
              <p>Couldn't read this changeset. {listed.error}</p>
              {listed.retry && (
                <Button size="sm" variant="ghost" onClick={listed.retry}>
                  Try again
                </Button>
              )}
            </div>
          ) : undefined
        }
      >
        {files && file && (
          <>
            {files.length > 1 && (
              <div className={styles.picker}>
                <Select
                  label="File"
                  variant="compact"
                  value={file.path}
                  onValueChange={setChosen}
                  groups={[
                    {
                      label: "Changed files",
                      options: files.map((each) => ({
                        value: each.path,
                        label: each.path,
                      })),
                    },
                  ]}
                />
                <IconButton
                  aria-label="Previous file"
                  icon={<CaretLeftIcon size={16} aria-hidden="true" />}
                  disabled={index === 0}
                  onClick={() => step(-1)}
                />
                <IconButton
                  aria-label="Next file"
                  icon={<CaretRightIcon size={16} aria-hidden="true" />}
                  disabled={index === files.length - 1}
                  onClick={() => step(1)}
                />
              </div>
            )}
            <FileDiff file={file} patch={patch} parsed={parsed} />
          </>
        )}
      </LoadingRegion>
    </div>
  );
}

function FileDiff({
  file,
  patch,
  parsed,
}: {
  file: ChangedFile;
  patch: {
    value?: string | undefined;
    error?: string | undefined;
    retry?: (() => void) | undefined;
  };
  parsed: ReturnType<typeof parsePatch>;
}) {
  if (file.binary)
    return <p className="text-body-sm">Binary file: no text diff to show.</p>;
  if (patch.error !== undefined)
    return (
      <div role="alert">
        <p className="text-body-sm">{patch.error}</p>
        {patch.retry && (
          <Button size="sm" variant="ghost" onClick={patch.retry}>
            Try again
          </Button>
        )}
      </div>
    );
  if (patch.value === undefined)
    return <p className="text-body-sm">Reading {file.path}…</p>;
  return (
    <DiffViewer content={patch.value} files={parsed} filePath={file.path} />
  );
}
