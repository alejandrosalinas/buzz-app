import { useId, useMemo, useState } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { Select } from "../../shared/design-system/ui/Select";
import {
  type AccountDetails as Details,
  type AccountDetailsErrors,
  type AccountDetailsInput,
  birthDateBounds,
  countryGroups,
  InvalidAccountDetails,
  invalidFieldMessage,
  validateAccountDetails,
} from "./account-details";
import styles from "./IdentitySetup.module.css";
import { OnboardingBack } from "./OnboardingBack";
import { OnboardingScreen } from "./OnboardingScreen";
import { SetupProgress } from "./SetupProgress";

const EMPTY: AccountDetailsInput = {
  firstName: "",
  lastName: "",
  dateOfBirth: "",
  countryCode: "",
};

/**
 * Pause for an account that hasn't finished Builderlab's account setup: the
 * web console's fields and rules, so desktop sign-up finishes it in Buzz. A
 * refusal returns to the form with what was typed kept.
 */
export function AccountDetails({
  email,
  onBack,
  onSave,
}: {
  email: string;
  onBack: () => void;
  /** Rejects with kgoose's refusal, shown on the form. */
  onSave: (details: Details) => Promise<void>;
}) {
  const formId = useId();
  const [input, setInput] = useState(EMPTY);
  const [errors, setErrors] = useState<AccountDetailsErrors>({});
  const [failure, setFailure] = useState<string>();
  const [busy, setBusy] = useState(false);
  const countries = useMemo(() => countryGroups(), []);
  const bounds = useMemo(() => birthDateBounds(), []);
  const change = (key: keyof AccountDetailsInput) => (value: string) =>
    setInput((current) => ({ ...current, [key]: value }));
  const submit = async () => {
    if (busy) return;
    const checked = validateAccountDetails(input);
    setFailure(undefined);
    if (!checked.details) return setErrors(checked.errors);
    setErrors({});
    setBusy(true);
    try {
      await onSave(checked.details);
    } catch (error) {
      if (error instanceof InvalidAccountDetails) {
        const named = Object.fromEntries(
          error.fields.flatMap((field) => {
            const message = invalidFieldMessage(field);
            return message ? [[field, message]] : [];
          }),
        );
        setErrors(named);
        if (
          Object.keys(named).length < error.fields.length ||
          !error.fields.length
        )
          setFailure(error.message);
      } else
        setFailure(
          error instanceof Error
            ? error.message
            : "We couldn’t save your details. Try again.",
        );
    } finally {
      setBusy(false);
    }
  };
  return (
    <OnboardingScreen
      labelledBy="welcome-title"
      intro={
        busy ? (
          <div className={`${styles.importContent} items-center`}>
            <SetupProgress label="Saving your details…" />
          </div>
        ) : (
          <form
            id={formId}
            noValidate
            className={styles.importContent}
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <h1
              id="welcome-title"
              tabIndex={-1}
              className="text-heading text-standard"
            >
              Finish setting up your account
            </h1>
            <p className="text-body text-subtle">
              Signed in as {email}. Builderlab needs a few details before you
              continue.
            </p>
            {failure && (
              <p role="alert" className="m-0 text-body-sm text-danger">
                {failure}
              </p>
            )}
            <div className={styles.importForm}>
              <Field label="First name" error={errors.first_name}>
                <Input
                  autoComplete="given-name"
                  value={input.firstName}
                  onValueChange={change("firstName")}
                  autoFocus
                />
              </Field>
              <Field label="Last name" error={errors.last_name}>
                <Input
                  autoComplete="family-name"
                  value={input.lastName}
                  onValueChange={change("lastName")}
                />
              </Field>
              <Field label="Date of birth" error={errors.date_of_birth}>
                <Input
                  type="date"
                  autoComplete="bday"
                  min={bounds.min}
                  max={bounds.max}
                  value={input.dateOfBirth}
                  onValueChange={change("dateOfBirth")}
                />
              </Field>
              <Select
                variant="field"
                label="Country or region"
                placeholder="Select"
                value={input.countryCode}
                groups={countries}
                error={errors.country_code}
                onValueChange={change("countryCode")}
              />
            </div>
            <p className="m-0 text-body-sm text-subtle">
              By continuing, you agree to the Buzz{" "}
              <a
                className="underline"
                href="https://buzz.xyz/terms-of-service"
                target="_blank"
                rel="noreferrer"
              >
                Terms of Service
              </a>{" "}
              and{" "}
              <a
                className="underline"
                href="https://buzz.xyz/privacy-policy"
                target="_blank"
                rel="noreferrer"
              >
                Privacy Policy
              </a>
              .
            </p>
          </form>
        )
      }
    >
      {!busy && (
        <>
          <Button type="submit" form={formId} size="lg" variant="prominent">
            Continue
          </Button>
          <OnboardingBack type="button" onClick={onBack} />
        </>
      )}
    </OnboardingScreen>
  );
}
