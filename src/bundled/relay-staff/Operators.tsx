import { useState } from "react";
import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { Select } from "../../shared/design-system/ui/Select";
import { typedPublicKey } from "../../shared/identity/public-key";
import type {
  OperatorDto,
  StaffRequest,
  StaffRole,
  StaffRoleSource,
} from "../../features/relay-staff/contract";
import { describe, useRead, useSession, useWrite } from "./session";
import { NamesSource, Person, PeopleScope, usePeople } from "./people";
import { containsSecretKey, Loaded, SECRET_KEY_WARNING } from "./ui";

type OperatorWrite = Extract<
  StaffRequest,
  { route: "putOperator" } | { route: "deleteOperator" }
>;

const SOURCES: Record<StaffRoleSource, string> = {
  config: "config",
  owner_fallback: "owner (fallback)",
  db: "db",
};
const ROLES = [
  {
    label: "",
    options: [
      { value: "moderator", label: "moderator" },
      { value: "operator", label: "operator" },
    ],
  },
];

/** Config-backed staff come from relay configuration and cannot change here. */
const configBacked = (operator: OperatorDto) =>
  operator.sources.some((source) => source !== "db");

export function Operators() {
  const { context, staff, canMutate } = useSession();
  const [list, reload] = useRead({ route: "listOperators" }, [context]);
  const [input, setInput] = useState("");
  const [role, setRole] = useState<StaffRole>("moderator");
  const [error, setError] = useState("");
  /** A change to your own entry re-checks your role. */
  const write = useWrite<OperatorWrite>("operators", (outcome, change) => {
    if (!outcome.ok) return setError(describe(outcome.failure));
    reload();
    if (change.route === "putOperator") setInput("");
    if (change.pubkey === context.signer) staff.reprobe(context);
  });
  const working = write.busy ? (write.frozen?.pubkey ?? null) : null;
  /** Every operator change shares one write, so all controls wait for it. */
  const busy = write.busy;
  const [removing, setRemoving] = useState<OperatorDto | null>(null);
  const pubkey = typedPublicKey(input);
  const secret = containsSecretKey(input);
  const keys = list.state === "ok" ? list.value.map((o) => o.pubkey) : [];
  const names = usePeople(keys);

  const after = (change: OperatorWrite) => {
    setError("");
    write.run(change);
  };
  const add = (operators: OperatorDto[]) => {
    if (!pubkey) return;
    const existing = operators.find((operator) => operator.pubkey === pubkey);
    if (existing)
      return setError(
        `Already staff as ${existing.effectiveRole}. Change their role on their row.`,
      );
    after({ route: "putOperator", pubkey, role });
  };

  return (
    <Loaded read={list} onRetry={reload}>
      {(operators) => (
        <div className="flex flex-col gap-4">
          {canMutate && (
            <div className="flex flex-col gap-2 rounded-md border px-3 py-2.5">
              <p className="text-caption font-medium text-secondary">
                Add staff
              </p>
              <div className="flex items-end gap-2">
                <Field
                  label="Public key"
                  error={secret ? SECRET_KEY_WARNING : undefined}
                >
                  <Input
                    placeholder="npub or 64-hex public key"
                    value={input}
                    disabled={busy}
                    onChange={(event) => setInput(event.target.value)}
                  />
                </Field>
                <Select
                  label="Role"
                  variant="compact"
                  value={role}
                  groups={ROLES}
                  disabled={busy}
                  onValueChange={(value) => setRole(value as StaffRole)}
                />
                <Button
                  size="sm"
                  loading={working !== null && working === pubkey}
                  disabled={!pubkey || busy}
                  onClick={() => add(operators)}
                >
                  Add
                </Button>
              </div>
            </div>
          )}
          {error && (
            <p className="text-body-sm text-danger" role="alert">
              {error}
            </p>
          )}
          {operators.length === 0 ? (
            <p className="text-body-sm text-secondary">No staff configured.</p>
          ) : (
            <PeopleScope people={names}>
              <NamesSource />
              <ul className="flex flex-col gap-1">
                {operators.map((operator) => {
                  const fixed = configBacked(operator);
                  const name = names.text(operator.pubkey);
                  return (
                    <li
                      key={operator.pubkey}
                      className="flex items-center gap-2 rounded-md border px-3 py-2 text-body-sm"
                    >
                      <span className="min-w-0 flex-1">
                        <Person
                          pubkey={operator.pubkey}
                          detail={
                            operator.pubkey === context.signer
                              ? "you"
                              : undefined
                          }
                        />
                      </span>
                      <span className="text-caption text-secondary">
                        {operator.sources
                          .map((source) => SOURCES[source])
                          .join(", ")}
                      </span>
                      {fixed || !canMutate ? (
                        <span className="text-caption">
                          {operator.effectiveRole}
                        </span>
                      ) : (
                        <Select
                          label={`Role for ${name}`}
                          variant="compact"
                          value={operator.effectiveRole}
                          groups={ROLES}
                          disabled={busy}
                          onValueChange={(value) =>
                            value !== operator.effectiveRole &&
                            after({
                              route: "putOperator",
                              pubkey: operator.pubkey,
                              role: value as StaffRole,
                            })
                          }
                        />
                      )}
                      {canMutate && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={fixed || busy}
                          title={
                            fixed
                              ? "Set in relay configuration; cannot be removed here"
                              : undefined
                          }
                          onClick={() => setRemoving(operator)}
                        >
                          Remove
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </PeopleScope>
          )}
          {removing && (
            <AlertDialog
              title="Remove staff?"
              description={
                removing.pubkey === context.signer
                  ? "You are removing your own staff access. You may not be able to undo this."
                  : `${names.text(removing.pubkey)} (${removing.effectiveRole}) loses relay staff access.`
              }
              onClose={() => setRemoving(null)}
              actions={
                <>
                  <Button onClick={() => setRemoving(null)}>Cancel</Button>
                  <Button
                    variant="destructive"
                    onClick={() => {
                      const target = removing.pubkey;
                      setRemoving(null);
                      after({ route: "deleteOperator", pubkey: target });
                    }}
                  >
                    Remove
                  </Button>
                </>
              }
            />
          )}
        </div>
      )}
    </Loaded>
  );
}
