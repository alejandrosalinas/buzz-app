import {
  TYPE_FAMILIES,
  TYPE_RAMPS,
  TYPE_ROLES,
  type TypeRole,
} from "../../../../src/shared/design-system/tokens/registry";

import { Note, PageHeader, Row, Rows, Section, Specimens } from "./primitives";

/**
 * Every specimen below is set in the role it documents, so the page is the
 * system rather than a description of it. A role that reads badly here reads
 * badly in the product.
 */
function RoleSpecimen({ role }: { role: TypeRole }) {
  return (
    <div className="flex flex-col gap-2">
      <p
        className={`${role.token} ${role.mono ? "font-mono" : ""} text-primary`}
      >
        {role.mono ? "createChannel(name, members)" : "Bring your agents in"}
      </p>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <code className="text-mono text-purple-12">{role.token}</code>
        <span className="text-body-sm text-tertiary">{role.pointsAt}</span>
        <span className="text-body-sm text-tertiary">
          {role.size} / {role.lineHeight} / {role.tracking} / {role.weight}
        </span>
      </div>
      <p className="max-w-xl text-body-sm text-secondary">{role.use}</p>
    </div>
  );
}

export function TypographyPage() {
  return (
    <>
      <PageHeader
        title="Typography"
        intro="Type roles combine size, line height, letter spacing and weight. Use Inter for interface and reading text, and JetBrains Mono for code and identifiers."
      />

      <Section
        title="The faces"
        description="Two font families, each with a defined purpose."
      >
        <Specimens>
          {TYPE_FAMILIES.map((family) => (
            <div key={family.token} className="flex flex-col gap-1.5">
              <p
                className={`text-heading text-primary ${
                  family.token === "font-mono" ? "font-mono" : "font-sans"
                }`}
              >
                {family.name}
              </p>
              <code className="text-mono text-purple-12">{family.token}</code>
              <p className="max-w-xl text-body-sm text-secondary">
                {family.use}
              </p>
            </div>
          ))}
        </Specimens>
      </Section>

      <Section
        title="The roles"
        description="Choose a role for the job the text does. Each sample uses its named utility; values list size, line height, letter spacing and weight."
      >
        <Specimens>
          {TYPE_ROLES.map((role) => (
            <RoleSpecimen key={role.token} role={role} />
          ))}
        </Specimens>
      </Section>

      {TYPE_RAMPS.map((ramp) => (
        <Section key={ramp.id} title={ramp.name} description={ramp.description}>
          <Rows>
            {ramp.steps.map((step) => (
              <Row key={`${ramp.id}-${step.step}`}>
                <div className="flex flex-wrap items-baseline gap-x-4">
                  <code className="w-28 shrink-0 text-mono text-primary">
                    {ramp.id}.{step.step}
                  </code>
                  <span className="w-20 shrink-0 text-body-sm text-secondary">
                    {step.value}
                  </span>
                  <span className="text-body-sm text-tertiary">{step.job}</span>
                </div>
              </Row>
            ))}
          </Rows>
        </Section>
      ))}

      <Note>
        Values are shown at 100% text size and scale with the text-size
        preference. A role supplies its own line height; section titles use 24px
        type with a 1.1 line height.
      </Note>
    </>
  );
}
