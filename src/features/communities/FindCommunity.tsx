import { useEffect, useEffectEvent, useRef, useState } from "react";
import { CircleNotchIcon } from "../../shared/design-system/icons/index";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { Button } from "../../shared/design-system/ui/Button";
import { Checkbox } from "../../shared/design-system/ui/Checkbox";
import { LoadingRegion } from "../../shared/design-system/ui/LoadingRegion";
import {
  FindCommunityError,
  findCommunity,
  nativeRelayFetch,
  type FindFailure,
  type FoundCommunity,
  type RelayFetch,
} from "./find-community";

import { ACCOUNT_CONSENT } from "./account-consent";
import { consentAsked } from "./join-policy";
import { communityName } from "./community-name";

type State =
  | { status: "finding" }
  | { status: "found"; found: FoundCommunity; consentGiven: boolean }
  | { status: "failed"; failure: FindFailure };

/** What the user ticked on Join Community; an invite claim attests `adult`. */
export type JoinConsent = Readonly<{ adult: boolean; agreed: boolean }>;

/** Classified copy; raw transport errors are never shown. */
const FAILURES: Record<FindFailure, { message: string; retry: boolean }> = {
  unreachable: {
    message: "Could not reach the relay. Check your connection and try again.",
    retry: true,
  },
  "not-buzz": { message: "This address isn’t a Buzz community.", retry: false },
  "no-community": {
    message: "No community is set up at this address.",
    retry: false,
  },
};

/**
 * Looks up a community at a canonical secure origin before any identity or
 * session exists. Owns nothing beyond the lookup: the caller either takes the
 * found community or decides what Join does. While `onJoin` is pending the page
 * holds still; what its failure means is the caller's to show.
 */
export function FindCommunity({
  url,
  onCancel,
  onFound,
  onJoin,
  autoJoin = false,
  consentGiven,
  request = nativeRelayFetch,
  titleId,
  onboarding = false,
}: {
  url: string;
  onCancel: () => void;
  request?: RelayFetch;
  titleId?: string;
  /** Uses the first-run page action layout; in-app dialogs keep their own. */
  onboarding?: boolean;
} & (
  | {
      /** Takes over a found community instead of showing Join Community; the lookup page stays until the caller moves on. */
      onFound: (found: FoundCommunity) => void;
      onJoin?: never;
      autoJoin?: never;
      consentGiven?: never;
    }
  | {
      onJoin: (
        found: FoundCommunity,
        consent: JoinConsent,
      ) => Promise<void> | void;
      /**
       * Joins a found community at once instead of showing Join Community,
       * unless its policy asks for consent. Join Community still follows a
       * join that returns without the caller moving on.
       */
      autoJoin?: boolean;
      /**
       * Whether a found community's consent was given already, by the
       * signed-in account (`accountConsents`): Join Community then asks
       * nothing, and Join attests it.
       */
      consentGiven?: (found: FoundCommunity) => boolean;
      onFound?: never;
    }
)) {
  const host = new URL(url).host;
  const [state, setState] = useState<State>({ status: "finding" });
  const [adult, setAdult] = useState(false);
  const [agreed, setAgreed] = useState(false);
  // How the pending `onJoin` began: from Join, or at once for `autoJoin`.
  const [joining, setJoining] = useState<"confirmed" | "auto">();
  const inFlight = useRef<AbortController>(null);
  const join = async (
    found: FoundCommunity,
    consent: JoinConsent,
    how: "confirmed" | "auto",
  ) => {
    setJoining(how);
    try {
      await onJoin?.(found, consent);
    } catch {
      // The caller shows what a failed join means; here it only ends the wait.
    } finally {
      setJoining(undefined);
    }
  };
  const settle = useEffectEvent((found: FoundCommunity) => {
    if (onFound) return onFound(found);
    const given = consentGiven?.(found) ?? false;
    setState({ status: "found", found, consentGiven: given });
    const asked = consentAsked(found.policy, given);
    if (autoJoin && !asked.age && !asked.agreement)
      void join(
        found,
        given ? ACCOUNT_CONSENT : { adult: false, agreed: false },
        "auto",
      );
  });
  useEffect(() => {
    if (state.status !== "finding") return;
    const controller = new AbortController();
    inFlight.current = controller;
    findCommunity(url, request, controller.signal).then(
      (found) => {
        if (!controller.signal.aborted) settle(found);
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          status: "failed",
          failure:
            error instanceof FindCommunityError ? error.failure : "unreachable",
        });
      },
    );
    return () => controller.abort();
  }, [url, request, state.status]);
  const cancel = () => {
    // Nothing from this lookup may land after leaving, even if we stay mounted.
    inFlight.current?.abort();
    onCancel();
  };
  const heading = (text: string) => (
    <h1 id={titleId} tabIndex={-1} className="text-heading text-standard">
      {text}
    </h1>
  );
  // An automatic join holds the lookup's page, as Join Community holds while joining.
  if (state.status === "finding" || joining === "auto")
    return (
      <>
        {heading(joining ? "Joining community" : "Finding community")}
        {/* An initial read: its status waits a second, the hostname and Cancel do not. */}
        <LoadingRegion
          pending
          label={joining ? `Joining ${host}…` : `Looking up ${host}…`}
        >
          <div className="flex flex-col gap-6">
            <p className="m-0 font-mono text-body text-subtle">{host}</p>
            <div>
              <Button
                size={onboarding ? "lg" : "md"}
                onClick={cancel}
                disabled={Boolean(joining)}
              >
                Cancel
              </Button>
            </div>
          </div>
        </LoadingRegion>
      </>
    );
  // Action rows follow the design system's footer order: secondary first, primary last.
  if (state.status === "failed") {
    const { message, retry } = FAILURES[state.failure];
    return (
      <>
        {heading("Couldn’t find community")}
        <p role="alert" className="text-body text-danger">
          {message}
        </p>
        <div
          className="flex gap-3"
          data-onboarding-actions={onboarding ? "" : undefined}
        >
          <Button size={onboarding ? "lg" : "md"} onClick={cancel}>
            Cancel
          </Button>
          {retry && (
            <Button
              variant="prominent"
              size={onboarding ? "lg" : "md"}
              onClick={() => setState({ status: "finding" })}
            >
              Retry
            </Button>
          )}
        </div>
      </>
    );
  }
  const { found, consentGiven: given } = state;
  const name = communityName(found.name, found.host);
  const policy = found.policy;
  const { age: needsAge, agreement: needsAgreement } = consentAsked(
    policy,
    given,
  );
  const consented = (!needsAge || adult) && (!needsAgreement || agreed);
  return (
    <>
      {heading("Join Community")}
      <div className="flex items-center gap-3 rounded-[var(--radius-row)] bg-surface-inset p-4">
        <Avatar
          alt=""
          fallback={name}
          fallbackSurface="panel"
          src={found.icon}
          shape="squircle"
          size="large"
        />
        <div className="min-w-0 flex-1">
          <p className="m-0 break-words text-body text-standard">{name}</p>
          <p className="m-0 break-all text-body text-subtle">{found.url}</p>
        </div>
      </div>
      {(needsAge || needsAgreement) && (
        <div className="flex flex-col gap-3">
          {needsAge && (
            <Checkbox
              checked={adult}
              onCheckedChange={setAdult}
              label="I confirm that I am at least 18 years old."
            />
          )}
          {needsAgreement && (
            <Checkbox
              checked={agreed}
              onCheckedChange={setAgreed}
              label={
                <>
                  I agree to this community’s{" "}
                  {policy?.terms_markdown && (
                    <PolicyLink url={url} document="terms">
                      Terms of Service
                    </PolicyLink>
                  )}
                  {policy?.terms_markdown && policy.privacy_markdown && " and "}
                  {policy?.privacy_markdown && (
                    <PolicyLink url={url} document="privacy">
                      Privacy Notice
                    </PolicyLink>
                  )}
                  .
                </>
              }
            />
          )}
        </div>
      )}
      {joining && (
        <p
          role="status"
          className="flex items-center gap-2 text-body text-subtle"
        >
          <CircleNotchIcon
            size={18}
            aria-hidden="true"
            className="motion-safe:animate-spin"
          />
          Joining…
        </p>
      )}
      <div
        className="flex gap-3"
        data-onboarding-actions={onboarding ? "" : undefined}
      >
        <Button
          size={onboarding ? "lg" : "md"}
          onClick={cancel}
          disabled={Boolean(joining)}
        >
          Cancel
        </Button>
        <Button
          variant="prominent"
          size={onboarding ? "lg" : "md"}
          disabled={!consented || Boolean(joining)}
          onClick={() =>
            void join(
              found,
              given ? ACCOUNT_CONSENT : { adult, agreed },
              "confirmed",
            )
          }
        >
          Join
        </Button>
      </div>
    </>
  );
}

/** Relay-hosted document pages open outside the app, as in `CommunityDialog`. */
function PolicyLink({
  url,
  document,
  children,
}: {
  url: string;
  document: "terms" | "privacy";
  children: string;
}) {
  return (
    <a
      href={`${url}/api/join-policy/${document}`}
      target="_blank"
      rel="noreferrer"
    >
      {children}
    </a>
  );
}
