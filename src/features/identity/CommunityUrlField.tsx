import { OnboardingBack } from "./OnboardingBack";
import { useState } from "react";
import { enteredRelayOrigin } from "../communities/destination";
import { parsePastedInvite } from "../communities/invite-link";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";

/**
 * A typed address (a bare host is a secure relay) with no code, else an invite
 * link — the relay's `https://<host>/invite/<code>` page or the `buzz://join`
 * link it opens — with its code. A bare address never resolves an alias.
 */
export function enteredCommunity(url: string) {
  try {
    return { origin: enteredRelayOrigin(url), code: "" };
  } catch {
    const invite = parsePastedInvite(url);
    return invite?.code
      ? { origin: invite.community, code: invite.code }
      : undefined;
  }
}

/**
 * The community URL field with its Continue button, shared by the first-run
 * landing and Join a community. Enter is handled by the input, not a native
 * form submit, so it reports an empty or invalid address whatever the button's
 * state; Continue therefore stays enabled (only `disabled` turns it off) and a
 * click shows the same error under the field. Continue only starts the lookup;
 * the join itself happens on Join Community.
 */
export function CommunityUrlField({
  url,
  onUrlChange,
  onSubmit,
  disabled = false,
  onBack,
  stacked = false,
}: {
  url: string;
  onUrlChange: (url: string) => void;
  /** Receives the canonical secure origin, and an invite link's code ("" for an address). */
  onSubmit: (origin: string, code: string) => void;
  disabled?: boolean;
  onBack?: () => void;
  /** Continue fills the width right under the field, for a card whose only step this is. */
  stacked?: boolean;
}) {
  const [invalid, setInvalid] = useState(false);
  const entered = enteredCommunity(url);
  const submit = () => {
    if (entered) onSubmit(entered.origin, entered.code);
    else setInvalid(true);
  };
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-col gap-12">
        <div className="min-w-0 w-full">
          <Field
            label="Community address or invite link"
            error={
              invalid ? "Enter a community address or invite link." : undefined
            }
            disabled={disabled}
          >
            <Input
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              placeholder="Paste a link or address"
              value={url}
              disabled={disabled}
              onChange={(event) => {
                onUrlChange(event.target.value);
                setInvalid(false);
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || event.nativeEvent.isComposing)
                  return;
                event.preventDefault();
                submit();
              }}
            />
          </Field>
        </div>
        {stacked ? (
          // A grid stretches the button to the field's width.
          <div className="grid">
            <Button
              size="lg"
              variant="prominent"
              disabled={disabled}
              onClick={submit}
            >
              Continue
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>{onBack && <OnboardingBack onClick={onBack} />}</div>
            <Button
              size="lg"
              variant="prominent"
              disabled={disabled}
              onClick={submit}
            >
              Continue
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
