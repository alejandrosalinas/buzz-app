import { useEffect, useId, useState } from "react";
import {
  CheckCircleIcon,
  XCircleIcon,
} from "../../../shared/design-system/icons/index";
import { Button } from "../../../shared/design-system/ui/Button";
import { Field } from "../../../shared/design-system/ui/Field";
import { Input } from "../../../shared/design-system/ui/Input";
import { HOST_SUFFIX, VALID_NAME } from "./api";

/**
 * A hosted community address being chosen, and whether Builderlab has it free:
 * `null` while checking. Settings' Create a community and first run's create
 * step share it; each owns its heading, quota copy and submit.
 */
export type CommunityAddress = Readonly<{
  name: string;
  setName(name: string): void;
  enabled: boolean;
  valid: boolean;
  available: boolean | null;
  failed: string;
  retry(): void;
  /** The address may be created now. */
  ready: boolean;
}>;

/** Checks a paused, valid address so the result is ready before Create. */
export function useCommunityAddress(
  availability: (name: string) => Promise<boolean>,
  enabled: boolean,
): CommunityAddress {
  const [name, setName] = useState("");
  const [available, setAvailable] = useState<boolean | null>(null);
  const [failed, setFailed] = useState("");
  const [attempt, setAttempt] = useState(0);
  const valid = name.length <= 63 && VALID_NAME.test(name);
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt re-runs the same check on retry.
  useEffect(() => {
    setAvailable(null);
    setFailed("");
    if (!enabled || !valid) return;
    let current = true;
    const timer = setTimeout(() => {
      void availability(name)
        .then((free) => current && setAvailable(free))
        .catch(
          (reason) =>
            current &&
            setFailed(
              reason instanceof Error ? reason.message : String(reason),
            ),
        );
    }, 500);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [availability, enabled, name, valid, attempt]);
  return {
    name,
    setName,
    enabled,
    valid,
    available,
    failed,
    retry: () => setAttempt((count) => count + 1),
    ready: enabled && valid && available === true,
  };
}

/**
 * The address field with its fixed suffix, and the availability check's
 * status or failure; a create's `refusal` of this address replaces both.
 */
export function CommunityAddressField({
  address,
  busy,
  refusal,
}: {
  address: CommunityAddress;
  busy: boolean;
  refusal?: string | undefined;
}) {
  const suffixId = useId();
  const { name, enabled, valid, available, failed } = address;
  return (
    <>
      <Field
        label="Community address"
        labelVisibility="hidden"
        invalid={Boolean(name) && !valid}
        error={
          name && !valid ? (
            "Use lowercase letters, numbers, and single hyphens."
          ) : available === false ? (
            <span className="inline-flex items-center gap-1.5">
              <XCircleIcon size={16} aria-hidden="true" />
              That address is already taken.
            </span>
          ) : undefined
        }
      >
        <div className="flex max-w-xl flex-wrap items-center gap-2">
          <div className="min-w-0 flex-1 basis-48">
            <Input
              autoComplete="off"
              spellCheck={false}
              maxLength={63}
              placeholder="north-star"
              aria-describedby={suffixId}
              disabled={!enabled || busy}
              value={name}
              onValueChange={(value) =>
                address.setName(value.trim().toLowerCase())
              }
            />
          </div>
          <span id={suffixId} className="shrink-0 text-body-sm text-muted">
            .{HOST_SUFFIX}
          </span>
        </div>
      </Field>
      {refusal ? (
        <p role="alert" className="m-0 break-words text-body-sm text-danger">
          {refusal}
        </p>
      ) : valid && enabled && failed ? (
        <div role="alert" className="text-body-sm">
          <p className="error m-0 break-words">{failed}</p>
          <div className="mt-2">
            <Button onClick={address.retry}>Check again</Button>
          </div>
        </div>
      ) : (
        <p
          role="status"
          className={`flex items-center gap-1.5 text-body-sm ${valid && enabled && available ? "text-success" : "text-muted"}`}
        >
          {valid && enabled ? (
            available === null ? (
              "Checking availability…"
            ) : available ? (
              <>
                <CheckCircleIcon size={16} aria-hidden="true" />
                That address is available.
              </>
            ) : null
          ) : null}
        </p>
      )}
    </>
  );
}
