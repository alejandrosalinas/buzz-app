import { prepareSoloMove } from "../channel-navigation/solo-navigation";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ComponentProps } from "react";
import type { RelaySession } from "../relay/session";
import type { ChannelSummary } from "../relay/contracts";
import {
  sameLabels,
  type ChannelDetails,
} from "../relay/channel-details-protocol";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Button } from "../../shared/design-system/ui/Button";
import { Select } from "../../shared/design-system/ui/Select";
import { useToastNotification } from "../../shared/design-system/ui/Toast";
import {
  chatConversion,
  updateChatConversion,
  useChatConversions,
  type ChatConversion,
} from "./conversion";
import {
  SOLO_ACCESS_DISCLOSURE,
  SOLO_LABEL,
  soloLabels,
  soloRetainedAccessWarning,
} from "./labels";
import { applySharedChannelDetails } from "./share";
import {
  generalAccessOptions,
  generalAccessPolicy,
  generalAccessValue,
  type GeneralAccess,
} from "../channels/general-access";

/** Presentation gating only; fresh signed details authorize the actual write. */
export function canConvertToChannel(
  session: RelaySession,
  channel?: ChannelSummary,
) {
  return !!(
    session.channelDetails?.available &&
    channel &&
    (channel.channelType === "solo" || !!chatConversion(session, channel.id)) &&
    !channel.cached &&
    !channel.readOnly &&
    !channel.archived &&
    !prepareSoloMove(session, channel.id)
  );
}

const withoutSolo = (labels: readonly string[] | undefined) =>
  (labels ?? []).filter((label) => label !== SOLO_LABEL);

function matchesConversion(base: ChannelDetails, receipt: ChatConversion) {
  return (
    !soloLabels(base.labels) &&
    base.name === receipt.draft.name &&
    base.visibility === receipt.draft.visibility &&
    (receipt.draft.joinRole === undefined ||
      base.joinRole === receipt.draft.joinRole) &&
    base.ttlSeconds === receipt.draft.ttlSeconds
  );
}

/** Clear the Solo label, drop the chat's project filing, then hand off navigation. */
export function ConvertToChannel({
  session,
  id,
  signal,
  close,
  finalFocus,
  onConverted,
}: {
  session: RelaySession;
  id: string;
  signal?: AbortSignal | undefined;
  close(): void;
  onConverted?: (() => void) | undefined;
  finalFocus?: ComponentProps<typeof Dialog>["finalFocus"];
}) {
  const details = session.channelDetails;
  const receipt = useChatConversions(session).get(id);
  const converted = !!receipt?.converted;
  const notify = useToastNotification();
  const attempt = useSyncExternalStore(details.subscribe, () =>
    details.snapshot(id),
  );
  const cancel = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(true);
  const completed = useRef(false);
  const [base, setBase] = useState<ChannelDetails>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [access, setAccess] = useState<GeneralAccess>();
  const lifetime = useRef<AbortController | undefined>(undefined);
  const pending = useRef(false);
  const conversionAttempt =
    attempt?.draft.labels && !soloLabels(attempt.draft.labels)
      ? attempt
      : undefined;
  const matchingAttempt = !!(
    base &&
    conversionAttempt?.draft.labels &&
    conversionAttempt.draft.name === base.name &&
    conversionAttempt.draft.description === base.description &&
    conversionAttempt.draft.ttlSeconds === base.ttlSeconds &&
    sameLabels(conversionAttempt.draft.labels, withoutSolo(base.labels))
  );
  const eligible = !!base?.canEdit && soloLabels(base.labels);
  // Another details surface may have confirmed the same publication and retired
  // its receipt. Require fresh exact intent evidence, not absence of an attempt.
  const confirmedElsewhere = !!(
    base &&
    receipt &&
    !attempt &&
    matchesConversion(base, receipt)
  );
  const canFinish = converted || confirmedElsewhere;
  // Uncertain intent belongs to the details owner, including admission.
  const savedDraft = receipt?.draft ?? conversionAttempt?.draft;
  const selectedAccess = savedDraft
    ? generalAccessValue(savedDraft)
    : (access ?? (base ? generalAccessValue(base) : "private"));

  const acceptDetails = useCallback(
    (next: ChannelDetails) => {
      setBase(next);
      const saved = chatConversion(session, id);
      // A fresh superseding edit retires only unconfirmed local orchestration.
      // Durable uncertainty and a completed metadata phase retain their owners.
      if (
        saved &&
        !saved.running &&
        !saved.converted &&
        !details.snapshot(id) &&
        !matchesConversion(next, saved)
      )
        updateChatConversion(session, id, undefined);
    },
    [details, id, session],
  );

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    const active = AbortSignal.any([
      controller.signal,
      ...(signal ? [signal] : []),
    ]);
    setBase(undefined);
    setAccess(undefined);
    setError("");
    setBusy(false);
    pending.current = false;
    void details
      .load(id, active)
      .then((next) => {
        if (!active.aborted) acceptDetails(next);
      })
      .catch((reason) => {
        if (!active.aborted)
          setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => controller.abort();
  }, [details, id, signal, acceptDetails]);

  const run = async (action: "convert" | "reload" | "check" | "finish") => {
    const controller = lifetime.current;
    if (
      !controller ||
      controller.signal.aborted ||
      signal?.aborted ||
      pending.current ||
      prepareSoloMove(session, id)
    )
      return;
    const active = AbortSignal.any([
      controller.signal,
      ...(signal ? [signal] : []),
    ]);
    pending.current = true;
    setBusy(true);
    setError("");
    let exact: ChatConversion | undefined;
    try {
      if (action === "reload") {
        const next = await details.load(id, active);
        if (!active.aborted) acceptDetails(next);
      } else {
        if (chatConversion(session, id)?.running)
          throw new Error("Conversion is already in progress in another view.");
        if (
          action !== "finish" &&
          (!base ||
            (action === "check"
              ? !matchingAttempt || attempt?.status !== "unconfirmed"
              : !eligible || !!attempt))
        )
          return;
        if (action === "finish" && !canFinish) return;
        if (!base && !receipt) return;
        exact = chatConversion(session, id) ?? {
          draft: {
            name: base?.name ?? "",
            description: base?.description ?? "",
            ...generalAccessPolicy(selectedAccess, base?.joinRole),
            ttlSeconds: base?.ttlSeconds,
            labels: withoutSolo(base?.labels),
          },
        };
        exact.running = true;
        updateChatConversion(session, id, exact);
        if (!exact.converted) {
          if (action === "check") await details.check(id, active);
          else if (action === "finish") {
            const fresh = await details.load(id, active);
            if (!matchesConversion(fresh, exact)) {
              setBase(fresh);
              if (!details.snapshot(id))
                updateChatConversion(session, id, undefined);
              throw new Error(
                "Channel settings changed. Reload details before continuing.",
              );
            }
          } else if (base)
            await applySharedChannelDetails(
              session,
              id,
              exact.draft,
              base,
              active,
            );
          exact.converted = true;
          updateChatConversion(session, id, exact);
        }
        active.throwIfAborted();
        // A channel is no longer filed in a Solo project.
        const projects = session.soloPreferences;
        if (projects.snapshot().status !== "unsupported") {
          await projects.refresh();
          active.throwIfAborted();
          const filing = projects.snapshot();
          if (filing.status !== "ready")
            throw new Error(
              filing.error ?? "Solo workspaces could not be read. Try again.",
            );
          if (filing.data?.assignments[id])
            await projects.assign(id, undefined);
          active.throwIfAborted();
        }
        updateChatConversion(session, id, undefined);
        if (!active.aborted) {
          notify("Converted to channel.", "success");
          completed.current = true;
          setOpen(false);
        }
      }
    } catch (reason) {
      if (!active.aborted)
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (exact) {
        delete exact.running;
        if (chatConversion(session, id) === exact)
          updateChatConversion(
            session,
            id,
            exact.converted || details.snapshot(id) || action === "finish"
              ? exact
              : undefined,
          );
      }
      if (!controller.signal.aborted) {
        pending.current = false;
        setBusy(false);
      }
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChangeComplete={(open) => {
        if (open) return;
        close();
        if (completed.current && !signal?.aborted) onConverted?.();
      }}
      initialFocus={cancel}
      title="Convert to channel"
      size="compact"
      headerGap="compact"
      footerGap="compact"
      description={
        base?.visibility === "private" && selectedAccess !== "private"
          ? SOLO_ACCESS_DISCLOSURE
          : (base &&
              selectedAccess === "private" &&
              soloRetainedAccessWarning(base)) ||
            "Move this conversation from Solo to Team. History, Canvas, members and lifetime stay the same."
      }
      onOpenChange={(open) => {
        if (!open) setOpen(false);
      }}
      preventClose={busy}
      finalFocus={completed.current ? false : finalFocus}
      actions={
        <>
          <Button ref={cancel} onClick={() => setOpen(false)} disabled={busy}>
            {converted ? "Close" : "Cancel"}
          </Button>
          {canFinish ? (
            <Button
              variant="prominent"
              disabled={busy || !!receipt?.running || !!signal?.aborted}
              onClick={() => void run("finish")}
            >
              Finish conversion
            </Button>
          ) : attempt?.status === "unconfirmed" && matchingAttempt ? (
            <Button
              disabled={busy || !!receipt?.running || !!signal?.aborted}
              onClick={() => void run("check")}
            >
              Check status
            </Button>
          ) : (
            <Button
              variant="prominent"
              disabled={
                busy ||
                !!receipt?.running ||
                !!attempt ||
                !eligible ||
                !!signal?.aborted
              }
              onClick={() => void run("convert")}
            >
              Convert to channel
            </Button>
          )}
        </>
      }
    >
      <Select
        label="General access"
        variant="field"
        value={selectedAccess}
        groups={[{ label: "", options: Object.values(generalAccessOptions) }]}
        disabled={
          busy ||
          converted ||
          !!receipt?.running ||
          !!attempt ||
          !eligible ||
          !!signal?.aborted
        }
        onValueChange={(value) => {
          const option = Object.values(generalAccessOptions).find(
            (option) => option.value === value,
          );
          if (option) setAccess(option.value);
        }}
      />
      {converted && (
        <p role="status">
          Channel converted. Finish removing it from its Solo workspace.
        </p>
      )}
      {!base && !error && <p role="status">Loading chat details…</p>}
      {base && !base.canEdit && !canFinish && (
        <p role="status">You don’t have permission to convert this chat.</p>
      )}
      {base?.canEdit && !eligible && !matchingAttempt && !canFinish && (
        <p role="status">Only a Solo chat can be converted.</p>
      )}
      {attempt && !matchingAttempt && !converted && (
        <p role="status">
          Finish the existing channel details change before converting.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {error && !converted && (
        <Button
          disabled={busy || !!signal?.aborted}
          onClick={() => void run("reload")}
        >
          Reload chat details
        </Button>
      )}
    </Dialog>
  );
}
