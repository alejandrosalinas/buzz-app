import { ExamplePreview } from "./ExamplePreview";
import { SectionHeading } from "./primitives";
import { useState } from "react";
import {
  ArrowRightIcon,
  CaretDownIcon,
  PlusIcon,
  TrashIcon,
  DotsThreeIcon,
  GearIcon,
  NotificationIcon,
  NotificationFilledIcon,
} from "../../../../src/shared/design-system/icons";
import { Avatar } from "../../../../src/shared/design-system/ui/Avatar";
import {
  MenuRoot,
  MenuTrigger,
  MenuPopup,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuGroup,
  MenuGroupLabel,
} from "../../../../src/shared/design-system/ui/Menu";
import { SurfaceButton } from "../../../../src/shared/design-system/ui/SurfaceButton";
import { Button } from "../../../../src/shared/design-system/ui/Button";
import { ChoiceRow } from "../../../../src/shared/design-system/ui/ChoiceRow";
import { IconButton } from "../../../../src/shared/design-system/ui/IconButton";
import { SplitButton } from "../../../../src/shared/design-system/ui/SplitButton";

const variants = [
  "prominent",
  "subtle",
  "subtle-muted",
  "ghost",
  "glass",
  "inverted",
  "destructive",
  "outline",
  "attention",
  "link",
] as const;
const sizes = ["sm", "md", "lg"] as const;
const descriptions = {
  prominent: "The main action in a group.",
  subtle: "A supporting action with a quiet fill.",
  "subtle-muted": "A quiet fill with muted text until interaction.",
  ghost: "A low-emphasis action without a resting fill.",
  glass: "A translucent action over artwork.",
  inverted: "An action on an inverse surface.",
  destructive: "An action that removes or destroys something.",
  outline: "A supporting action with a visible boundary.",
  attention:
    "An overdue action with a light red dashed stroke and slow marching ants (proposed).",
  link: "An action that underlines on interaction.",
};

/** Viewer-only matrix: both pages exercise the production controls. */
function ButtonMatrix({ kind }: { kind: "text" | "icon" }) {
  const [state, setState] = useState<"enabled" | "disabled" | "loading">(
    "enabled",
  );
  return (
    <section
      aria-label={`${kind === "text" ? "Button" : "Icon button"} variants`}
      className="component-specimen-stack"
    >
      <div className="flex flex-col gap-6">
        <SectionHeading
          title="Emphasis and sizes"
          description="Small · 32px, medium · 40px, large · 52px. Medium icon + label uses 12px leading / 16px trailing padding. Hover, press, or Tab through the controls to inspect their states."
        />
        <fieldset className="flex flex-wrap gap-2" aria-label="Preview state">
          {(["enabled", "disabled", "loading"] as const).map((value) => (
            <Button
              key={value}
              size="sm"
              variant={state === value ? "prominent" : "subtle"}
              aria-pressed={state === value}
              onClick={() => setState(value)}
            >
              Show {value}
            </Button>
          ))}
        </fieldset>
      </div>
      {variants.map((variant) => (
        <section
          key={variant}
          aria-label={`${variant} examples`}
          className="component-specimen-group"
        >
          <h3 className="text-label text-primary">
            {variant} · {descriptions[variant]}
          </h3>
          <ExamplePreview
            className={`${variant === "inverted" ? "bg-surface-inverse" : ""}`}
            code={(kind === "text" ? ["xs", ...sizes] : sizes)
              .map((size) => {
                const stateProp = state === "enabled" ? "" : ` ${state}`;
                return kind === "text"
                  ? `<Button size="${size}" variant="${variant}"${stateProp}>\n  <ArrowRightIcon aria-hidden="true" /> Continue\n</Button>`
                  : `<IconButton size="${size}" variant="${variant}"${stateProp}\n  aria-label="Add item" icon={<PlusIcon aria-hidden="true" />} />`;
              })
              .join("\n\n")}
          >
            <div className="component-specimen-row">
              {(kind === "text" ? (["xs", ...sizes] as const) : sizes).map(
                (size) => (
                  <div key={size} className="component-specimen">
                    {kind === "icon" ? (
                      <IconButton
                        aria-label={`${variant} ${size}`}
                        size={size}
                        variant={variant}
                        icon={<PlusIcon aria-hidden="true" />}
                        disabled={state === "disabled"}
                        loading={state === "loading"}
                      />
                    ) : (
                      <Button
                        size={size}
                        variant={variant}
                        aria-label={`${variant} ${size}`}
                        disabled={state === "disabled"}
                        loading={state === "loading"}
                      >
                        <ArrowRightIcon aria-hidden="true" /> Continue
                      </Button>
                    )}
                    <code
                      className={`component-specimen-prop text-mono-sm ${variant === "inverted" ? "text-inverse" : "text-tertiary"}`}
                    >
                      size="{size}"
                    </code>
                  </div>
                ),
              )}
            </div>
          </ExamplePreview>
        </section>
      ))}
    </section>
  );
}

export function ButtonSpecimen() {
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [labelled, setLabelled] = useState(false);
  return (
    <div className="component-specimen-stack">
      <ExamplePreview
        className="justify-center"
        code={`<Button>Continue</Button>`}
      >
        <Button>Continue</Button>
      </ExamplePreview>
      <ButtonMatrix kind="text" />
      <ExamplePreview code='<SplitButton menuLabel="Other add options" menu={<MenuItem>View only</MenuItem>}>Add</SplitButton>'>
        <SplitButton
          variant="prominent"
          menuLabel="Other add options"
          menu={
            <MenuGroup>
              <MenuGroupLabel>Add as</MenuGroupLabel>
              <MenuItem>
                <ChoiceRow
                  label="Participant"
                  description="Send messages, reply, and react."
                />
              </MenuItem>
              <MenuItem>
                <ChoiceRow
                  label="View only"
                  description="Read messages and threads."
                />
              </MenuItem>
              <MenuItem>
                <ChoiceRow
                  label="Admin"
                  description="Manage this channel and its members."
                />
              </MenuItem>
            </MenuGroup>
          }
        >
          Add
        </SplitButton>
      </ExamplePreview>
      <ExamplePreview
        className="bg-affordance-accent"
        code='<Button variant="glass">Message</Button>'
      >
        <Button variant="glass">Message</Button>
        <Button variant="glass" loading>
          Message
        </Button>
        <Button variant="glass" disabled>
          Message
        </Button>
      </ExamplePreview>
      <div className="buzz-compact-controls">
        <Button size="caption" variant="plain">
          Compact action
        </Button>
        <Button size="sm" shape="icon" variant="plain" aria-label="Add">
          <PlusIcon />
        </Button>
      </div>
      <Button size="caption" variant="subtle-muted">
        Send
      </Button>
      <ExamplePreview code='<Button size="sm" shape={labelled ? "capsule" : "icon"} aria-label="Toggle label">…</Button>'>
        <Button
          size="sm"
          variant="ghost"
          shape={labelled ? "capsule" : "icon"}
          aria-label="Toggle label"
          onClick={() => setLabelled(!labelled)}
        >
          <PlusIcon aria-hidden="true" />
          {labelled && "Labelled action"}
        </Button>
      </ExamplePreview>
      <ExamplePreview
        code={`<Button size="text" variant="link">Manage account</Button>`}
      >
        <Button size="text" variant="link">
          Manage account
        </Button>
        <Button size="text" variant="link" disabled>
          Manage account
        </Button>
      </ExamplePreview>
      <ExamplePreview
        code={`<Button size="inline" variant="plain" aria-expanded={expanded}>Previous steps <CaretDownIcon aria-hidden="true" /></Button>`}
      >
        <Button
          size="inline"
          variant="plain"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          Previous steps <CaretDownIcon aria-hidden="true" />
        </Button>
        <Button size="inline" variant="plain" disabled>
          Previous steps <CaretDownIcon aria-hidden="true" />
        </Button>
      </ExamplePreview>
      <ExamplePreview
        code={`<Button size="inline" variant="ghost">Model <CaretDownIcon aria-hidden="true" /></Button>`}
      >
        <Button size="inline" variant="ghost">
          Model <CaretDownIcon aria-hidden="true" />
        </Button>
        <Button size="inline" variant="ghost" disabled>
          Model <CaretDownIcon aria-hidden="true" />
        </Button>
      </ExamplePreview>
      <section
        aria-label="Artwork controls"
        className="component-specimen-stack"
      >
        <SectionHeading
          title="Surface button (proposed)"
          description="Artwork supplies the layout; shared activation and keyboard focus stay consistent."
        />
        <ExamplePreview code='<SurfaceButton aria-label="Choose artwork"><PlusIcon /></SurfaceButton>'>
          <SurfaceButton aria-label="Choose artwork" className="rounded-xl p-4">
            <PlusIcon size={32} />
          </SurfaceButton>
          <SurfaceButton
            aria-label="Unavailable artwork"
            disabled
            className="rounded-xl p-4"
          >
            <PlusIcon size={32} />
          </SurfaceButton>
        </ExamplePreview>
      </section>
      <section
        aria-label="Button behavior"
        className="component-specimen-group"
      >
        <SectionHeading
          title="Loading and expansion"
          description="Saving keeps the same width and focus. Finish the example with the separate completion control."
        />
        <ExamplePreview
          code={`<div className="min-w-0 space-y-4">
  <div className="flex flex-wrap items-start gap-4">
    <Button
      loading={loading}
      variant="prominent"
      onClick={() => setLoading(true)}
    >
      Save changes
    </Button>
    <Button disabled={!loading} onClick={() => setLoading(false)}>
      Complete saving
    </Button>
    <Button loading disabled loadingAppearance="disabled">
      Disabled while loading
    </Button>
  </div>
  <Button
    aria-expanded={expanded}
    aria-controls="button-example-details"
    onClick={() => setExpanded(!expanded)}
  >
    Show details
  </Button>
  <p
    id="button-example-details"
    hidden={!expanded}
    className="text-body-sm text-subtle"
  >
    The trigger keeps its pressed emphasis while this content is
    expanded.
  </p>
</div>`}
        >
          <div className="min-w-0 space-y-4">
            <div className="component-specimen-row">
              <Button
                loading={loading}
                variant="prominent"
                onClick={() => setLoading(true)}
              >
                Save changes
              </Button>
              <Button disabled={!loading} onClick={() => setLoading(false)}>
                Complete saving
              </Button>
              <Button loading disabled loadingAppearance="disabled">
                Disabled while loading
              </Button>
            </div>
            <Button
              aria-expanded={expanded}
              aria-controls="button-example-details"
              onClick={() => setExpanded(!expanded)}
            >
              Show details
            </Button>
            <p
              id="button-example-details"
              hidden={!expanded}
              className="text-body-sm text-subtle"
            >
              The trigger keeps its pressed emphasis while this content is
              expanded.
            </p>
          </div>
        </ExamplePreview>
      </section>
      <section aria-label="Button content" className="component-specimen-group">
        <SectionHeading
          title="Single-line labels"
          description="Labels stay on one line. Let the surrounding layout wrap whole controls or scroll when space is limited, rather than squeezing the label."
        />
        <ExamplePreview
          code={`<div className="min-w-0 space-y-4">
  <div className="flex flex-wrap items-start gap-4">
    <Button>Text only</Button>
    <Button>
      <PlusIcon aria-hidden="true" /> Create project
    </Button>
    <Button>
      Continue <ArrowRightIcon aria-hidden="true" />
    </Button>
    <Button variant="outline">Choose a workspace</Button>
  </div>
  <div className="flex w-full max-w-96 items-center gap-4">
    <p className="m-0 min-w-0 flex-1 text-body-sm text-secondary">
      Changes affect future starts and restarts. Running work is never
      restarted automatically.
    </p>
    <Button variant="prominent">Apply changes</Button>
  </div>
  <div className="max-w-48">
    <Button>
      <PlusIcon aria-hidden="true" /> Allow notifications for this
      workspace
    </Button>
  </div>
</div>`}
        >
          <div className="min-w-0 space-y-4">
            <div className="component-specimen-row">
              <Button>Text only</Button>
              <Button>
                <PlusIcon aria-hidden="true" /> Create project
              </Button>
              <Button>
                Continue <ArrowRightIcon aria-hidden="true" />
              </Button>
              <Button variant="outline">Choose a workspace</Button>
            </div>
            <div className="flex w-full max-w-96 items-center gap-4">
              <p className="m-0 min-w-0 flex-1 text-body-sm text-secondary">
                Changes affect future starts and restarts. Running work is never
                restarted automatically.
              </p>
              <Button variant="prominent">Apply changes</Button>
            </div>
            <div className="max-w-48">
              <Button>
                <PlusIcon aria-hidden="true" /> Allow notifications for this
                workspace
              </Button>
            </div>
          </div>
        </ExamplePreview>
      </section>
    </div>
  );
}

export function IconButtonSpecimen() {
  const [unread, setUnread] = useState(false);
  return (
    <div className="component-specimen-stack">
      <p className="text-body-sm text-subtle">
        Icon actions default to small: a 32px control with 16px artwork.
        Labelled buttons stay medium; choose a larger icon size explicitly.
      </p>
      <ExamplePreview
        label="Squircle avatar action"
        code={
          '<IconButton variant="prominent" shape="squircle" aria-label="Add item" icon={<PlusIcon />} />'
        }
      >
        <IconButton
          variant="prominent"
          shape="squircle"
          aria-label="Add item"
          icon={<PlusIcon />}
        />
      </ExamplePreview>
      <ExamplePreview
        className="justify-center"
        code={`<IconButton
  aria-label="Add item"
  icon={<PlusIcon aria-hidden="true" />}
/>`}
      >
        <IconButton
          aria-label="Add item"
          icon={<PlusIcon aria-hidden="true" />}
        />
      </ExamplePreview>
      <ExamplePreview
        label="Glyph-state toggle"
        code={
          '<IconButton variant="bare" size="sm" aria-pressed={unread} aria-label="Unread only" icon={unread ? <NotificationFilledIcon size="1.25rem" /> : <NotificationIcon size="1.25rem" />} />'
        }
      >
        <IconButton
          variant="bare"
          size="sm"
          aria-label="Unread only"
          aria-pressed={unread}
          title="Show unread only"
          onClick={() => setUnread(!unread)}
          icon={
            unread ? (
              <NotificationFilledIcon size="1.25rem" />
            ) : (
              <NotificationIcon size="1.25rem" />
            )
          }
        />
      </ExamplePreview>
      <ButtonMatrix kind="icon" />
      <IconButton
        variant="destructive-quiet"
        shape="inset"
        aria-label="Remove queued message"
        icon={<TrashIcon />}
      />
      <ExamplePreview
        label="Row-end action"
        code={`<div className="flex min-h-12 items-center rounded-row bg-affordance-subtle">
  <span className="px-control-inset text-body-sm">Row action</span>
  <IconButton
    size="sm"
    shape="row-end"
    aria-label="Row actions"
    icon={<DotsThreeIcon aria-hidden="true" />}
  />
</div>`}
      >
        <div className="flex min-h-12 items-center rounded-row bg-affordance-subtle">
          <span className="px-control-inset text-body-sm">Row action</span>
          <IconButton
            size="sm"
            shape="row-end"
            aria-label="Row actions"
            icon={<DotsThreeIcon aria-hidden="true" />}
          />
        </div>
      </ExamplePreview>
      <ExamplePreview
        code={`<IconButton
  size="xs"
  shape="control"
  aria-label="Dense formatting option"
  title="Dense formatting option (20px)"
  icon={<PlusIcon />}
/>
<code className="text-mono-sm">size="xs" · 20px</code>`}
      >
        <IconButton
          size="xs"
          shape="control"
          aria-label="Dense formatting option"
          title="Dense formatting option (20px)"
          icon={<PlusIcon />}
        />
        <code className="text-mono-sm">size="xs" · 20px</code>
      </ExamplePreview>
      <section
        className="component-specimen-group"
        aria-label="Buzz icon treatments"
      >
        <SectionHeading
          title="Buzz treatments"
          description="Tint supports quiet composer actions. Chrome uses the workspace glass material. Top-bar and content-toolbar actions share 32px containers and even 10px corners; avatar controls remain round."
        />
        <ExamplePreview
          code={`<div className="flex flex-wrap items-start gap-4">
  <IconButton
    variant="tint"
    aria-label="Tinted add"
    icon={<PlusIcon aria-hidden="true" />}
  />
  <IconButton
    variant="subtle"
    shape="control"
    aria-label="Control shape"
    icon={<GearIcon aria-hidden="true" />}
  />
</div>`}
        >
          <div className="component-specimen-row">
            <IconButton
              variant="tint"
              aria-label="Tinted add"
              icon={<PlusIcon aria-hidden="true" />}
            />
            <IconButton
              variant="subtle"
              shape="control"
              aria-label="Control shape"
              icon={<GearIcon aria-hidden="true" />}
            />
          </div>
        </ExamplePreview>
      </section>
      <section
        className="component-specimen-group"
        aria-label="Avatar icon treatments"
      >
        <SectionHeading
          title="Avatar · Transparent cutouts"
          description="Hover, press, or open the menu: the backdrop stays visible through the avatar cutout. Tab to the enabled control to inspect keyboard focus."
        />
        <ExamplePreview
          backdrop
          code={`<div className="flex flex-wrap items-start gap-4">
  <MenuRoot>
    <MenuTrigger
      render={
        <IconButton
          variant="avatar"
          aria-label="Avatar profile menu"
          icon={
            <Avatar
              alt="Alex Morgan"
              fallback="A"
              size="fill"
              statusBadge="online"
            />
          }
        />
      }
    />
    <MenuPopup size="compact">
      <MenuItem>View profile</MenuItem>
    </MenuPopup>
  </MenuRoot>
  <IconButton
    variant="avatar"
    disabled
    aria-label="Disabled avatar profile"
    icon={
      <Avatar
        alt="Sam Rivera"
        fallback="S"
        size="fill"
        statusBadge="away"
      />
    }
  />
</div>`}
        >
          <div className="component-specimen-row">
            <MenuRoot>
              <MenuTrigger
                render={
                  <IconButton
                    variant="avatar"
                    aria-label="Avatar profile menu"
                    icon={
                      <Avatar
                        alt="Alex Morgan"
                        fallback="A"
                        size="fill"
                        statusBadge="online"
                      />
                    }
                  />
                }
              />
              <MenuPopup size="compact">
                <MenuItem>View profile</MenuItem>
              </MenuPopup>
            </MenuRoot>
            <IconButton
              variant="avatar"
              disabled
              aria-label="Disabled avatar profile"
              icon={
                <Avatar
                  alt="Sam Rivera"
                  fallback="S"
                  size="fill"
                  statusBadge="away"
                />
              }
            />
          </div>
        </ExamplePreview>
      </section>
      <section
        className="component-specimen-group"
        aria-label="Chrome icon treatments"
      >
        <h2 className="text-label text-primary">
          Chrome · Workspace glass material
        </h2>
        <ExamplePreview
          backdrop
          code={`<div className="flex flex-wrap items-start gap-4">
  <IconButton
    variant="chrome"
    aria-label="Chrome settings"
    icon={<GearIcon aria-hidden="true" />}
  />
  <IconButton
    variant="chrome"
    disabled
    aria-label="Disabled chrome settings"
    icon={<GearIcon aria-hidden="true" />}
  />
</div>`}
        >
          <div className="component-specimen-row">
            <IconButton
              variant="inset"
              shape="round"
              size="md"
              aria-label="Inset action"
              icon={<GearIcon aria-hidden="true" />}
            />
            <IconButton
              variant="inset"
              disabled
              shape="round"
              size="md"
              aria-label="Disabled inset action"
              icon={<GearIcon aria-hidden="true" />}
            />
            <IconButton
              variant="chrome"
              aria-label="Chrome settings"
              icon={<GearIcon aria-hidden="true" />}
            />
            <IconButton
              variant="chrome"
              disabled
              aria-label="Disabled chrome settings"
              icon={<GearIcon aria-hidden="true" />}
            />
          </div>
        </ExamplePreview>
      </section>
      <section
        className="component-specimen-group"
        aria-label="Media icon treatment"
      >
        <h2 className="text-label text-primary">
          Media · Static dark glass over video
        </h2>
        <ExamplePreview
          backdrop
          code={`<IconButton
  variant="media"
  aria-label="Media settings"
  icon={<GearIcon aria-hidden="true" />}
/>`}
        >
          <IconButton
            variant="media"
            aria-label="Media settings"
            icon={<GearIcon aria-hidden="true" />}
          />
        </ExamplePreview>
      </section>
    </div>
  );
}

const harnesses = ["Claude", "Codex", "Goose"] as const;

export function SplitButtonSpecimen() {
  const [choice, setChoice] = useState<string>(harnesses[0]);
  const [loading, setLoading] = useState(false);
  const menu = (
    <MenuRadioGroup value={choice} onValueChange={setChoice}>
      {harnesses.map((item) => (
        <MenuRadioItem key={item} value={item} closeOnClick>
          {item}
        </MenuRadioItem>
      ))}
    </MenuRadioGroup>
  );
  const run = () => {
    setLoading(true);
    setTimeout(() => setLoading(false), 1200);
  };
  return (
    <div className="component-specimen-stack">
      <p className="text-body-sm text-subtle">
        The label names the chosen option. Choosing in the menu changes it
        without running the action.
      </p>
      <ExamplePreview
        className="justify-center"
        code={`<SplitButton
  menuLabel="Choose agent type"
  menu={<MenuRadioGroup value={choice} onValueChange={setChoice}>…</MenuRadioGroup>}
  onClick={run}
>
  Import as {choice}
</SplitButton>`}
      >
        {(["subtle", "outline", "prominent"] as const).map((variant) => (
          <SplitButton
            key={variant}
            variant={variant}
            size="sm"
            menuLabel="Choose agent type"
            menu={menu}
            loading={loading}
            onClick={run}
          >
            Import as {choice}
          </SplitButton>
        ))}
      </ExamplePreview>
      <ExamplePreview
        label="Medium and disabled"
        code={`<SplitButton menuLabel="Choose agent type" menu={menu}>Import as {choice}</SplitButton>
<SplitButton variant="outline" menuLabel="Choose agent type" menu={menu} disabled>Import as {choice}</SplitButton>`}
      >
        <SplitButton menuLabel="Choose agent type" menu={menu} onClick={run}>
          Import as {choice}
        </SplitButton>
        <SplitButton
          variant="outline"
          menuLabel="Choose agent type"
          menu={menu}
          disabled
        >
          Import as {choice}
        </SplitButton>
      </ExamplePreview>
    </div>
  );
}
