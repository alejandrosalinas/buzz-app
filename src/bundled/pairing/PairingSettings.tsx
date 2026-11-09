import { isTauri } from "@tauri-apps/api/core";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  CheckIcon as Check,
  CircleNotchIcon as LoaderCircle,
} from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { Input } from "../../shared/design-system/ui/Input";
import type { CommunityReader } from "../../features/communities/service";
export type PairingSettingsProps = {
  communities: CommunityReader;
  active(): boolean;
};
import {
  communityDestination,
  relayOrigin,
} from "../../features/communities/destination";
import {
  createPairingClient,
  nativePairing,
  pairingAvailable,
  type PairingNative,
} from "../../features/pairing/client";
import { writeClipboardText } from "../../shared/clipboard";
import { QrCode } from "../../shared/QrCode";

export function PairingSettings({
  communities,
  active,
  native = nativePairing,
  available = pairingAvailable(),
}: PairingSettingsProps & { native?: PairingNative; available?: boolean }) {
  const client = useSyncExternalStore(
    communities.subscribe,
    communities.snapshot,
  );
  const pairing = useMemo(() => createPairingClient(native), [native]);
  const state = useSyncExternalStore(pairing.subscribe, pairing.snapshot);
  const [account, setAccount] = useState<string>();
  const [manualOrigin, setManualOrigin] = useState<string>();
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string>();
  const [copied, setCopied] = useState<{ uri: string; failed: boolean }>();
  const [relay, setRelay] = useState(() =>
    client.selected ? communityDestination(client.selected).url : "",
  );
  const lifetime = useRef(0);
  useEffect(() => {
    lifetime.current++;
    return () => {
      lifetime.current++;
      void pairing.cancel(true);
    };
  }, [pairing]);
  // Changing accounts/communities invalidates the pairing being displayed.
  useEffect(() => {
    lifetime.current++;
    setReading(false);
    setManualOrigin(undefined);
    setAccount(client.viewer);
    setRelay(client.selected ? communityDestination(client.selected).url : "");
    return () => {
      void pairing.cancel(true);
    };
  }, [client.viewer, client.selected, pairing]);
  const busy = [
    "connecting",
    "qr",
    "code",
    "transferring",
    "cancelling",
  ].includes(state.phase);
  async function prepare() {
    const attempt = lifetime.current;
    setError(undefined);
    setReading(true);
    try {
      const viewer = await native.account();
      if (attempt !== lifetime.current) return;
      if (client.viewer && viewer !== client.viewer)
        throw new Error(
          "Your saved Buzz account doesn’t match this account. Open the matching account before pairing.",
        );
      setAccount(viewer);
    } catch (error) {
      if (attempt === lifetime.current) setError(String(error));
    } finally {
      if (attempt === lifetime.current) setReading(false);
    }
  }
  async function copy(uri: string) {
    try {
      await writeClipboardText(uri);
      setCopied({ uri, failed: false });
    } catch {
      setCopied({ uri, failed: true });
    }
  }
  function start() {
    setError(undefined);
    try {
      if (!account || !active()) return;
      const origin = relayOrigin(relay);
      if (!client.selected) setManualOrigin(origin);
      void pairing.start(account, origin);
    } catch {
      setError("Enter your community’s https:// or wss:// address.");
    }
  }
  useEffect(() => {
    if (
      !available ||
      !account ||
      (!client.selected && !manualOrigin) ||
      !active() ||
      (client.viewer && account !== client.viewer) ||
      (client.selected &&
        relay !== communityDestination(client.selected).url) ||
      !["idle", "expired"].includes(state.phase)
    )
      return;
    const origin = client.selected ? relayOrigin(relay) : manualOrigin;
    if (origin) void pairing.start(account, origin);
  }, [
    available,
    account,
    client.viewer,
    client.selected,
    manualOrigin,
    active,
    relay,
    state.phase,
    pairing,
  ]);
  const scanned = ["code", "transferring", "complete", "uncertain"].includes(
    state.phase,
  );
  const confirmed = ["transferring", "complete"].includes(state.phase);
  const done = state.phase === "complete";
  const verificationInstructions =
    "If your phone asks for a code, enter these digits and finish confirming on your phone. If it shows a code, check that the digits match. Then choose Codes match here to send your Buzz identity.";
  const steps = [
    {
      id: "scan",
      title: "Scan QR code",
      detail:
        "Open Buzz on your phone and choose Add community to scan the code shown here.",
      complete: scanned,
    },
    {
      id: "verify",
      title: "Verify the code on your phone",
      detail: verificationInstructions,
      complete: confirmed,
    },
    {
      id: "finish",
      title: done ? "Paired" : "Pair your mobile app",
      detail: done
        ? "Your account was sent. Check that it’s signed in on your phone."
        : "Your mobile app will connect after you verify the code.",
      complete: done,
    },
  ];
  return (
    <section aria-labelledby="pair-mobile-title" className="min-w-0">
      <h2 id="pair-mobile-title" className="mt-0 mb-2 text-label">
        Pair mobile
      </h2>
      <p className="mt-0 mb-6 text-body-sm text-muted">
        Connect the Buzz mobile app to this community. Pairing is secured with
        end-to-end encryption and a verification code.
      </p>
      <div className="w-full [container-type:inline-size]">
        <p aria-live="polite" className="sr-only">
          {state.phase === "qr" && copied?.uri === state.uri
            ? copied.failed
              ? "Couldn’t copy the pairing code."
              : "Pairing code copied."
            : state.phase === "code"
              ? `Verification code ${state.code.split("").join(" ")}. ${verificationInstructions}`
              : done
                ? "Your phone is paired."
                : ""}
        </p>
        <div className="flex flex-col items-stretch gap-6 p-6 [@container(min-width:46rem)]:flex-row [@container(min-width:46rem)]:gap-6 [@container(min-width:46rem)]:p-12">
          <div className="flex w-64 max-w-full shrink-0 flex-col gap-3 self-center [@container(min-width:46rem)]:self-start">
            <div className="flex h-64 w-full flex-col items-center justify-center gap-4 overflow-auto text-center">
              {!available ? (
                <p role="status" className="text-body-sm text-muted">
                  {isTauri()
                    ? "Pairing uses this app’s native identity and is unavailable with the development broker. Restart with BUZZ_DEV_VIEWER empty to use native sign-in."
                    : "Open the Buzz desktop app to pair your phone."}
                </p>
              ) : (
                <>
                  {!busy &&
                    !done &&
                    state.phase !== "uncertain" &&
                    (!account ? (
                      <Button disabled={reading} onClick={() => void prepare()}>
                        {reading
                          ? "Opening your account…"
                          : "Use existing Buzz account"}
                      </Button>
                    ) : (
                      <>
                        {!client.selected && (
                          <div className="flex w-full flex-col gap-2 text-left">
                            <label
                              htmlFor="pair-community"
                              className="text-label-sm"
                            >
                              Community address
                            </label>
                            <Input
                              id="pair-community"
                              value={relay}
                              placeholder="https://your-community.example"
                              onChange={(e) => setRelay(e.target.value)}
                              onBlur={() => {
                                if (relay.trim()) start();
                              }}
                              onKeyDown={(e) => {
                                if (e.key === "Enter" && relay.trim()) start();
                              }}
                              autoComplete="off"
                              spellCheck={false}
                            />
                          </div>
                        )}
                        {["error", "cancelled"].includes(state.phase) && (
                          <Button variant="prominent" onClick={start}>
                            Try again
                          </Button>
                        )}
                      </>
                    ))}
                  {state.phase === "connecting" && (
                    <div
                      role="status"
                      className="flex flex-col items-center gap-3 text-body-sm text-muted"
                    >
                      <LoaderCircle
                        aria-hidden="true"
                        size={24}
                        className="motion-safe:animate-spin"
                      />
                      Creating pairing code…
                    </div>
                  )}
                  {state.phase === "qr" && (
                    <QrCode
                      svg={state.svg}
                      alt="Scan this QR code with Buzz on your phone"
                    />
                  )}
                  {state.phase === "code" && (
                    <div className="flex min-h-64 w-full flex-col justify-between gap-6">
                      <h3 className="m-0 text-label">
                        Verify the code on your phone
                      </h3>
                      <fieldset className="m-0 w-full whitespace-nowrap rounded-xl border border-shell-edge bg-surface px-4 py-4">
                        <legend className="sr-only">Pairing code</legend>
                        <span className="sr-only">
                          {state.code.split("").join(" ")}
                        </span>
                        <span
                          aria-hidden="true"
                          className="font-mono text-title font-semibold tracking-widest"
                        >
                          {state.code.slice(0, 3)} {state.code.slice(3)}
                        </span>
                      </fieldset>
                      <div className="flex flex-col gap-2">
                        <Button
                          variant="prominent"
                          onClick={() => void pairing.confirm()}
                        >
                          Codes match
                        </Button>
                        <Button onClick={() => void pairing.deny()}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  )}
                  {state.phase === "cancelling" && (
                    <p role="status" className="text-body-sm text-muted">
                      Cancelling pairing…
                    </p>
                  )}
                  {state.phase === "cancelled" && (
                    <p role="status" className="text-body-sm text-muted">
                      Pairing was canceled.
                    </p>
                  )}
                  {state.phase === "transferring" && (
                    <div
                      role="status"
                      className="flex flex-col items-center gap-3 text-body-sm text-muted"
                    >
                      <LoaderCircle
                        aria-hidden="true"
                        size={24}
                        className="motion-safe:animate-spin"
                      />
                      Finishing pairing on your phone…
                    </div>
                  )}
                  {state.phase === "uncertain" && (
                    <div
                      role="status"
                      className="flex flex-col items-center gap-3"
                    >
                      <h3 className="m-0 text-label">Check your phone</h3>
                      <p className="m-0 text-body-sm text-muted">
                        The account was sent, but your phone hasn’t confirmed.
                        It may already be paired.
                      </p>
                      <Button onClick={start}>Start a new pairing</Button>
                    </div>
                  )}
                  {done && (
                    <div
                      role="status"
                      className="flex flex-col items-center gap-3"
                    >
                      <Check
                        aria-hidden="true"
                        size={40}
                        className="text-success"
                      />
                      <h3 className="m-0 text-label">Phone paired</h3>
                      <Button onClick={start}>Pair another phone</Button>
                    </div>
                  )}
                  {(error || state.phase === "error") && (
                    <div className="flex flex-col items-center gap-3">
                      <p role="alert" className="m-0 text-body-sm text-danger">
                        {error ??
                          (state.phase === "error" ? state.message : "")}
                      </p>
                    </div>
                  )}
                </>
              )}
            </div>
            {available && (
              // Reserve the slot in every phase so the steps never shift.
              <div className="flex min-h-10 flex-col">
                {state.phase === "qr" && (
                  <Button onClick={() => void copy(state.uri)}>
                    {copied?.uri !== state.uri
                      ? "Copy pairing code"
                      : copied.failed
                        ? "Couldn’t copy. Try again"
                        : "Copied"}
                  </Button>
                )}
              </div>
            )}
          </div>
          <ol
            aria-label="Pairing steps"
            className="m-0 grid w-full min-w-0 flex-1 auto-rows-fr list-none self-center gap-3 p-0"
          >
            {steps.map((step, index) => (
              <li
                key={step.id}
                className="flex min-h-24 min-w-0 items-start gap-4"
              >
                <span
                  aria-hidden="true"
                  className={`flex size-12 shrink-0 items-center justify-center rounded-full text-label ${step.complete ? "bg-affordance-success text-success" : "bg-affordance-subtle text-primary"}`}
                >
                  {step.complete ? <Check size={24} /> : index + 1}
                </span>
                <div className="min-w-0">
                  <p className="m-0 text-label">
                    {step.title}
                    <span className="sr-only">
                      {step.complete ? ", complete" : ""}
                    </span>
                  </p>
                  <p className="mt-1 mb-0 text-body-sm text-muted">
                    {step.detail}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}
