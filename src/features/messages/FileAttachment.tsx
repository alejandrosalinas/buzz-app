import type { FileCardProps } from "../conversation/contracts";
import {
  IconButton,
  type IconButtonProps,
} from "../../shared/design-system/ui/IconButton";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import {
  ArrowUpRightIcon,
  ArrowsClockwiseIcon,
  CheckIcon,
  CircleNotchIcon,
  DownloadIcon,
} from "../../shared/design-system/icons/index";
import { FileTypeIcon } from "./FileTypeIcon";
import fileIconStyles from "./FileTypeIcon.module.css";
import type { Attachment } from "../relay/contracts";
import {
  isNativeMediaSource,
  isProxySource,
  safeOpenUrl,
} from "./attachment-source";
import styles from "./Messages.module.css";
import { useNativeDownload, type DownloadState } from "./use-native-download";
import type { ReactNode } from "react";

export function formatFileSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  if (size < 1024 * 1024 * 1024)
    return `${Math.round(size / (1024 * 1024))} MB`;
  return `${Math.round(size / (1024 * 1024 * 1024))} GB`;
}

function mimeLabel(mime: string | undefined): string | undefined {
  if (!mime) return undefined;
  const [type, subtype] = mime.split("/");
  if (!type || !subtype) return undefined;
  if (subtype === "pdf") return "PDF file";
  if (!/^[a-z0-9]+$/i.test(subtype)) return undefined;
  return `${subtype.toUpperCase()} file`;
}

export function FileAttachment({
  attachment,
  source,
  onOpenLink,
  onPreview,
  typeLabel,
}: Omit<FileCardProps, "source"> & { source: string | undefined }) {
  const displayName = attachment.name ?? mimeLabel(attachment.mime) ?? "File";
  const nativeSource = source ? isNativeMediaSource(source) : false;
  const proxySource = source ? isProxySource(source) || nativeSource : false;
  const externalSource = !!source && safeOpenUrl(source) && !proxySource;
  if (source && !proxySource && !externalSource)
    return (
      <UnavailableFileAttachment
        displayName={displayName}
        attachment={attachment}
      />
    );

  if (source && proxySource && onPreview) {
    const renderPreview = (
      state: DownloadState = "idle",
      download?: () => Promise<void>,
    ) => {
      const action = {
        "aria-label": `${state === "failed" ? "Retry download" : "Download"} ${displayName}`,
        title: `Download ${displayName}`,
        icon:
          state === "failed" ? (
            <ArrowsClockwiseIcon aria-hidden="true" />
          ) : state === "saved" ? (
            <CheckIcon aria-hidden="true" />
          ) : (
            <DownloadIcon aria-hidden="true" />
          ),
        shape: "row-end",
      } satisfies IconButtonProps;
      return (
        <div className={styles.filePreviewAttachment}>
          <div className={styles.filePreviewMain}>
            <NavigationItem
              aria-label={`Preview ${displayName}`}
              icon={
                <span className={fileIconStyles.slot}>
                  <FileTypeIcon name={attachment.name} mime={attachment.mime} />
                </span>
              }
              label={
                <span className={styles.fileAttachmentBody}>
                  <span
                    className={styles.fileAttachmentName}
                    title={displayName}
                  >
                    {displayName}
                  </span>
                  <span className={styles.fileAttachmentMeta}>
                    {state === "pending" ? (
                      "Downloading…"
                    ) : state === "saved" ? (
                      "Saved to Downloads"
                    ) : state === "failed" ? (
                      "Couldn’t download · Retry"
                    ) : (
                      <>
                        {typeLabel ?? mimeLabel(attachment.mime) ?? "File"}
                        {attachment.size !== undefined &&
                          ` · ${formatFileSize(attachment.size)}`}
                      </>
                    )}
                  </span>
                </span>
              }
              onClick={onPreview}
            />
          </div>
          <span className={styles.fileDownloadAction}>
            {nativeSource ? (
              <IconButton
                {...action}
                loading={state === "pending"}
                onClick={() => void download?.()}
              />
            ) : (
              <IconButton
                {...action}
                nativeButton={false}
                role="link"
                render={<a href={source} download={attachment.name ?? ""} />}
              />
            )}
          </span>
        </div>
      );
    };
    return nativeSource ? (
      <NativeFileDownload
        key={JSON.stringify([source, attachment.name])}
        source={source}
        name={attachment.name ?? ""}
        displayName={displayName}
      >
        {renderPreview}
      </NativeFileDownload>
    ) : (
      renderPreview()
    );
  }

  const content = (state: DownloadState = "idle") => (
    <>
      <span className={fileIconStyles.slot}>
        <FileTypeIcon name={attachment.name} mime={attachment.mime} />
      </span>
      <span className={styles.fileAttachmentBody}>
        <span className={styles.fileAttachmentName}>{displayName}</span>
        <span className={styles.fileAttachmentMeta}>
          {state === "pending"
            ? "Downloading…"
            : state === "saved"
              ? "Saved to Downloads"
              : state === "failed"
                ? "Couldn’t download · Retry"
                : source
                  ? attachment.size
                    ? formatFileSize(attachment.size)
                    : proxySource
                      ? "Download file"
                      : "Open file"
                  : "File unavailable"}
        </span>
      </span>
      {state === "pending" ? (
        <CircleNotchIcon
          size={20}
          className="motion-safe:animate-spin"
          aria-hidden="true"
        />
      ) : state === "saved" ? (
        <CheckIcon size={20} aria-hidden="true" />
      ) : state === "failed" ? (
        <ArrowsClockwiseIcon size={20} aria-hidden="true" />
      ) : proxySource ? (
        <DownloadIcon size={20} aria-hidden="true" />
      ) : (
        <ArrowUpRightIcon size={20} aria-hidden="true" />
      )}
    </>
  );
  if (!source)
    return (
      <UnavailableFileAttachment
        displayName={displayName}
        attachment={attachment}
      />
    );
  if (externalSource)
    return (
      <a
        className={styles.fileAttachment}
        href={source}
        target="_blank"
        rel="noreferrer"
        aria-label={`Open ${displayName}`}
        title={displayName}
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey) return;
          if (onOpenLink(source)) event.preventDefault();
        }}
      >
        {content()}
      </a>
    );
  if (nativeSource)
    return (
      <NativeFileDownload
        key={JSON.stringify([source, attachment.name])}
        source={source}
        name={attachment.name ?? ""}
        displayName={displayName}
      >
        {(state, download) => (
          <button
            type="button"
            className={styles.fileAttachment}
            aria-label={`${state === "failed" ? "Retry download" : "Download"} ${displayName}`}
            aria-disabled={state === "pending"}
            aria-busy={state === "pending"}
            title={displayName}
            onClick={() => void download()}
          >
            {content(state)}
          </button>
        )}
      </NativeFileDownload>
    );
  return (
    <a
      className={styles.fileAttachment}
      href={source}
      download={attachment.name ?? ""}
      aria-label={`Download ${displayName}`}
      title={displayName}
    >
      {content()}
    </a>
  );
}

/** A source/name change mounts a fresh download lifetime, retiring old results. */
function NativeFileDownload({
  source,
  name,
  displayName,
  children,
}: {
  source: string;
  name: string;
  displayName: string;
  children(state: DownloadState, download: () => Promise<void>): ReactNode;
}) {
  const { state, download } = useNativeDownload(source, name);
  const announcement =
    state === "pending"
      ? `Downloading ${displayName}`
      : state === "saved"
        ? `Saved ${displayName} to Downloads`
        : state === "failed"
          ? `Couldn’t download ${displayName}. Try again.`
          : "";
  return (
    <>
      {children(state, download)}
      <span className="sr-only" role={state === "failed" ? "alert" : "status"}>
        {announcement}
      </span>
    </>
  );
}

function UnavailableFileAttachment({
  displayName,
  attachment,
}: {
  displayName: string;
  attachment: Attachment;
}) {
  return (
    <span className={styles.fileAttachment} role="status" title={displayName}>
      <span className={fileIconStyles.slot}>
        <FileTypeIcon name={attachment.name} mime={attachment.mime} />
      </span>
      <span className={styles.fileAttachmentBody}>
        <span className={styles.fileAttachmentName}>{displayName}</span>
        <span className={styles.fileAttachmentMeta}>File unavailable</span>
      </span>
    </span>
  );
}
