import { Button } from "../../../../src/shared/design-system/ui/Button";
import { IconButton } from "../../../../src/shared/design-system/ui/IconButton";
import { DotsThreeIcon } from "../../../../src/shared/design-system/icons";
import { RAMPS } from "../../../../src/shared/design-system/tokens/registry";

import { PageHeader, Section } from "./primitives";

const GLASS = RAMPS.find((ramp) => ramp.id === "glass");

const MATERIALS = [
  {
    utility: "glass-primary",
    spec: "glass-2 · blur-md · rim",
    use: "On the backdrop",
  },
  {
    utility: "glass-secondary",
    spec: "glass-4 · blur-lg · rim · shadow-sm",
    use: "Over glass",
  },
];

/**
 * A material, rendered as itself over the backdrop.
 *
 * The label sits inside the specimen rather than in a caption beneath it: the
 * subject is a translucent surface, so text on it is part of what is being
 * judged — whether it stays legible with the gradient reading through.
 */
function Material({ material }: { material: (typeof MATERIALS)[number] }) {
  return (
    <div
      className={`${material.utility} flex min-h-[8rem] flex-col justify-between gap-6 rounded-xl px-5 py-4`}
    >
      <span className="text-body-sm text-secondary">{material.use}</span>
      <div className="flex flex-col gap-1">
        <code className="text-mono text-primary">{material.utility}</code>
        <span className="text-body-sm text-tertiary">{material.spec}</span>
      </div>
    </div>
  );
}

export function GlassPage() {
  return (
    <>
      <PageHeader
        title="Glass"
        intro="Use glass where the backdrop should remain visible. Two shared materials combine fill, blur, rim, and elevation: primary sits on the backdrop; secondary sits over glass."
      />

      <Section
        title="The materials"
        description="Compare both materials over the app backdrop, where their transparency is visible."
      >
        <div className="glass-scene grid gap-4 rounded-xl p-6 sm:grid-cols-2">
          {MATERIALS.map((material) => (
            <Material key={material.utility} material={material} />
          ))}
        </div>
      </Section>

      <Section
        title="Interactive"
        description="Use an interactive material for a glass control. Hover increases the fill by one step and keeps blur unchanged."
      >
        <div className="glass-scene flex flex-wrap gap-3 rounded-xl p-6">
          <button
            type="button"
            className="glass-primary-interactive rounded-full px-5 py-2.5 text-body text-primary transition-colors"
          >
            glass-primary-interactive
          </button>
          <button
            type="button"
            className="glass-secondary-interactive rounded-full px-5 py-2.5 text-body text-primary transition-colors"
          >
            glass-secondary-interactive
          </button>
        </div>
      </Section>

      <Section
        title="Quiet artwork controls (proposed)"
        description="Transparent at rest; primary glass on hover and while open. Blur and geometry stay fixed."
      >
        <div className="glass-scene flex flex-wrap gap-3 rounded-xl p-6">
          <IconButton
            variant="glass-ghost"
            aria-label="Agent actions"
            icon={<DotsThreeIcon />}
          />
          <Button variant="glass-ghost" size="xs">
            Model choice
          </Button>
          <Button variant="glass-ghost" size="xs" aria-expanded="true">
            Open menu
          </Button>
          <Button variant="glass-ghost" size="xs" disabled>
            Unavailable
          </Button>
        </div>
      </Section>

      <Section
        title="Clear glass action (proposed)"
        description="Barely-there glass for a secondary action beside a prominent one on a bright brand surface."
      >
        <div className="glass-scene flex flex-wrap gap-3 rounded-xl p-6">
          <Button variant="prominent" size="lg">
            Create account
          </Button>
          <Button variant="glass-clear" size="lg">
            Sign in
          </Button>
        </div>
      </Section>

      {GLASS ? (
        <Section
          title="The ramp"
          description="Each step increases the opacity of the current mode’s surface color. These samples show fills only; materials add the rim."
        >
          {/* One continuous strip rather than five separate swatches: the
              subject is a progression, and gaps between cards let the backdrop
              re-enter between them so each step is read against a different
              part of the gradient instead of against its neighbours.
              Deliberately not the shared `Swatch` — its hairline border reads
              as the glass rim on a translucent fill. */}
          <div className="glass-scene rounded-xl p-6">
            <div className="glass-ramp overflow-hidden rounded-xl">
              {GLASS.steps.map((step) => (
                <div
                  key={step.variable}
                  className="blur-chrome flex min-w-0 flex-1 flex-col justify-end gap-1 px-3 py-4"
                  style={{ background: `var(${step.variable})` }}
                >
                  <code className="break-words text-mono-sm text-primary">
                    glass {step.step}
                  </code>
                  <span className="break-words text-body-sm text-tertiary">
                    {step.job}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </Section>
      ) : null}

      <Section
        title="The rim"
        description="Two inset shadows make the lit edge brighter and the opposite edge quieter. Keep their light direction consistent across glass surfaces."
      >
        <div className="glass-scene rounded-xl p-6">
          <div className="glass-primary rounded-xl px-5 py-4">
            <code className="whitespace-pre-wrap break-words text-mono-sm text-primary">
              {`inset 0  1px 0 var(--rim-lit)\ninset 0 -1px 0 var(--rim-shade)`}
            </code>
          </div>
        </div>
      </Section>
    </>
  );
}
