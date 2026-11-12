import { SidebarNavigation } from "../../../../src/shared/design-system/ui/SidebarNavigation";
import { LoadingRegion } from "../../../../src/shared/design-system/ui/LoadingRegion";
import { SettingsGroup } from "../../../../src/shared/design-system/ui/SettingsGroup";
import { EmptyState } from "../../../../src/shared/design-system/ui/EmptyState";
import { ExamplePreview } from "./ExamplePreview";
import { Calendar } from "../../../../src/shared/design-system/ui/Calendar";
import { FieldButton } from "../../../../src/shared/design-system/ui/FieldButton";
import {
  MenuRoot,
  MenuItem,
  MenuTrigger,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
} from "../../../../src/shared/design-system/ui/Menu";
import {
  MenuSpecimen,
  PopoverSpecimen,
  ChoiceRowSpecimen,
} from "./MenuSpecimens";
import {
  Header,
  InlineHeader,
} from "../../../../src/shared/design-system/ui/Header";
import {
  InputExamples,
  TextareaExamples,
  SearchExamples,
  SelectExamples,
  ComboboxExamples,
} from "./FormSpecimens";
import { ToastSpecimens } from "./ToastSpecimens";
import {
  ButtonSpecimen,
  IconButtonSpecimen,
  SplitButtonSpecimen,
} from "./ButtonSpecimens";
import { AlertDialog } from "../../../../src/shared/design-system/ui/AlertDialog";
import { DialogSpecimens } from "./DialogSpecimens";
import { Tooltip } from "../../../../src/shared/design-system/ui/Tooltip";
import { Field } from "../../../../src/shared/design-system/ui/Field";
import { Input } from "../../../../src/shared/design-system/ui/Input";
import { Textarea } from "../../../../src/shared/design-system/ui/Textarea";
import {
  Radio,
  RadioGroup,
} from "../../../../src/shared/design-system/ui/RadioGroup";
import { Checkbox } from "../../../../src/shared/design-system/ui/Checkbox";
import avatarUrl from "../assets/avatar.png";
import { PanelSwapPlaygrounds } from "./PanelSwapPlaygrounds";
import { FlexWorkspace } from "../../../../src/shared/design-system/ui/FlexWorkspace";
import { BentoSpecimen } from "./BentoSpecimen";
import {
  CaretDownIcon,
  DotsThreeIcon,
  TrashIcon,
  ArrowLeftIcon,
  HashIcon,
  ChatCircleIcon,
  PlusIcon,
  SmileyIcon,
  SquaresFourIcon,
  GlobeIcon,
} from "../../../../src/shared/design-system/icons/index";
import type { ReactNode } from "react";
import { useId, useState } from "react";
import {
  ThemePicker,
  type ThemeMode,
} from "../../../../src/shared/design-system/ui/ThemePicker";
import { KeyboardShortcut } from "../../../../src/shared/design-system/ui/KeyboardShortcut";
import { CountBadge } from "../../../../src/shared/design-system/ui/CountBadge";

function ThemePickerSpecimen() {
  const [value, setValue] = useState<ThemeMode>("system");
  return <ThemePicker value={value} onValueChange={setValue} />;
}
import { Switch } from "../../../../src/shared/design-system/ui/Switch";
import { PreferenceRow } from "../../../../src/shared/design-system/ui/PreferenceRow";
import { Select } from "../../../../src/shared/design-system/ui/Select";
import { SwitchPreferenceRow } from "../../../../src/shared/design-system/ui/SwitchPreferenceRow";
import { Accordion } from "../../../../src/shared/design-system/ui/Accordion";

import { Avatar } from "../../../../src/shared/design-system/ui/Avatar";
import { AvatarStack } from "../../../../src/shared/design-system/ui/AvatarStack";
import { ShimmerText } from "../../../../src/shared/design-system/ui/ShimmerText";
import { TypingDots } from "../../../../src/shared/design-system/ui/TypingDots";
import { InlineChip } from "../../../../src/shared/design-system/ui/InlineChip";
import { Button } from "../../../../src/shared/design-system/ui/Button";
import { IconButton } from "../../../../src/shared/design-system/ui/IconButton";
import {
  NavigationCard,
  NavigationItem,
} from "../../../../src/shared/design-system/ui/NavigationItem";
import {
  NavigationSection,
  NavigationSectionHeading,
} from "../../../../src/shared/design-system/ui/NavigationSection";
import {
  PanelHeader,
  PanelHeaderLabel,
} from "../../../../src/shared/design-system/ui/PanelHeader";
import { Tabs } from "../../../../src/shared/design-system/ui/Tabs";

import { ComponentAnatomy } from "./ComponentAnatomy";
import { Panel } from "../../../../src/shared/design-system/ui/Panel";
import { FullPageSurface } from "../../../../src/shared/design-system/ui/FullPageSurface";
import { PreviewCard } from "../../../../src/shared/design-system/ui/PreviewCard";
import type { ChipAddress } from "../../../../src/shared/design-system/chips/address";
import { chipFaces } from "../../../../src/shared/design-system/chips/faceResolver";
import { ComposerSpecimen } from "./ComposerSpecimen";

const DESTINATIONS = [
  { value: "home", label: "Home" },
  { value: "messages", label: "Messages" },
  { value: "projects", label: "Projects" },
] as const;

type Destination = (typeof DESTINATIONS)[number]["value"];

function CalendarSpecimen() {
  const [date, setDate] = useState(new Date());
  return (
    <SpecimenFrame
      code={`<Calendar mode="single" required selected={date} onSelect={setDate} />`}
    >
      <Calendar mode="single" required selected={date} onSelect={setDate} />
    </SpecimenFrame>
  );
}

function FieldButtonSpecimen() {
  const [duration, setDuration] = useState("Today");
  return (
    <SpecimenFrame
      code={`<MenuRoot>
  <MenuTrigger render={<FieldButton aria-label="Duration" />}>
    {duration}
  </MenuTrigger>
  <MenuPopup>
    <MenuRadioGroup value={duration} onValueChange={setDuration}>
      {["Today", "This week", "Custom"].map((item) => (
        <MenuRadioItem key={item} value={item}>
          {item}
        </MenuRadioItem>
      ))}
    </MenuRadioGroup>
  </MenuPopup>
</MenuRoot>`}
    >
      <MenuRoot>
        <MenuTrigger render={<FieldButton aria-label="Duration" />}>
          {duration}
        </MenuTrigger>
        <MenuPopup>
          <MenuRadioGroup value={duration} onValueChange={setDuration}>
            {["Today", "This week", "Custom"].map((item) => (
              <MenuRadioItem key={item} value={item}>
                {item}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuPopup>
      </MenuRoot>
      <MenuRoot>
        <MenuTrigger
          render={
            <FieldButton
              appearance="masked"
              prefix="key"
              aria-label="Value actions"
            />
          }
        >
          <span aria-hidden="true">••••••••••••••••</span>
        </MenuTrigger>
        <MenuPopup>
          <MenuItem>Copy</MenuItem>
          <MenuItem>Reveal</MenuItem>
        </MenuPopup>
      </MenuRoot>
    </SpecimenFrame>
  );
}

function SpecimenFrame({
  children,
  code,
  backdrop = false,
}: {
  children: ReactNode;
  code: string;
  backdrop?: boolean;
}) {
  return (
    <ExamplePreview code={code} backdrop={backdrop}>
      {children}
    </ExamplePreview>
  );
}

function SpecimenGroup({
  label,
  code,
  children,
}: {
  label: string;
  code: string;
  children: ReactNode;
}) {
  return (
    <section className="component-specimen-group">
      <h2 className="text-label text-primary">{label}</h2>
      <ExamplePreview label={label} code={code}>
        {children}
      </ExamplePreview>
    </section>
  );
}

/**
 * One sample with the prop that produced it printed underneath.
 *
 * A row of four icon buttons is unreadable without this — they differ only by
 * fill, so there is no way to tell which one is `solid` and which is `chrome`,
 * and the page is documentation. The caption names the prop as you would type
 * it (`variant="solid"`), not a prose paraphrase, so reading the page tells you
 * what to write.
 */
function Specimen({
  prop,
  children,
}: {
  /** As typed in JSX, e.g. `variant="quiet"`. Omit for a default. */
  prop?: string;
  children: ReactNode;
}) {
  return (
    <div className="component-specimen">
      {children}
      <code className="component-specimen-prop text-mono-sm text-tertiary">
        {prop ?? "default"}
      </code>
    </div>
  );
}

function ShimmerTextSpecimen() {
  return (
    <div className="component-specimen-row">
      <Specimen prop="active (default)">
        <span className="text-body-sm">
          <ShimmerText>Bash</ShimmerText>
        </span>
      </Specimen>
      <Specimen prop="active={false}">
        <span className="text-body-sm">
          <ShimmerText active={false}>Finished</ShimmerText>
        </span>
      </Specimen>
    </div>
  );
}

function TypingDotsSpecimen() {
  const [state, setState] = useState<"waiting" | "working">("waiting");
  return (
    <div className="component-specimen-stack">
      <div className="component-specimen-row">
        <Specimen prop='state="waiting"'>
          <span className="flex items-center gap-2 text-body">
            <TypingDots state="waiting" /> Received · waiting to start
          </span>
        </Specimen>
        <Specimen prop='size="small"'>
          <TypingDots size="small" />
        </Specimen>
        <Specimen prop='state="working" (default)'>
          <span className="flex items-center gap-2 text-body">
            <TypingDots /> Working
          </span>
        </Specimen>
      </div>
      <ExamplePreview
        label="Activity transition"
        code={'<TypingDots state="waiting" />\n<TypingDots state="working" />'}
      >
        <div className="component-specimen-stack">
          <span
            role="status"
            aria-label="Example activity"
            className="flex items-center gap-2 text-body"
          >
            <TypingDots state={state} />
            {state === "waiting" ? "Received · waiting to start" : "Working"}
          </span>
          <Button
            size="sm"
            onClick={() =>
              setState(state === "waiting" ? "working" : "waiting")
            }
          >
            {state === "waiting" ? "Start work" : "Reset to waiting"}
          </Button>
        </div>
      </ExamplePreview>
    </div>
  );
}

function AvatarStackSpecimen() {
  const items = [
    { id: "alex", name: "Alex", shape: "circle" as const },
    { id: "brain", name: "Brain", shape: "squircle" as const },
    { id: "casey", name: "Casey", shape: "circle" as const },
    { id: "helper", name: "Helper", shape: "squircle" as const },
  ];
  return (
    <div className="component-specimen-row">
      <Button
        size="xs"
        variant="subtle"
        aria-label="Alex, Brain, Casey, and Helper"
      >
        <AvatarStack items={items} />
      </Button>
      <Button
        size="xs"
        variant="subtle"
        shape="control"
        aria-label="Small agent activity"
      >
        <AvatarStack items={items.slice(1, 3)} size="mini" />
        <TypingDots size="small" />
      </Button>
      <Button
        variant="ghost"
        aria-label="Thread with Alex, Brain, Casey, and Helper"
      >
        <AvatarStack items={items} size="small" /> 4 replies
      </Button>
      <Button variant="ghost" aria-label="Seven agents to import">
        <AvatarStack
          items={[
            ...items,
            { id: "dana", name: "Dana", shape: "squircle" },
            { id: "eli", name: "Eli", shape: "squircle" },
            { id: "fern", name: "Fern", shape: "squircle" },
          ]}
          size="hero"
          max={5}
        />
      </Button>
      <AvatarStack items={items} size="hero-large" max={5} animateEntrance />
    </div>
  );
}

function AvatarSpecimen() {
  return (
    <div className="component-specimen-stack">
      <SpecimenGroup
        label="Identity shape: circles for humans, squircles for agents"
        code={`<div className="flex flex-wrap items-center gap-4">

    <Avatar alt="Alex Lee" fallback="Alex" shape="circle" />


    <Avatar alt="Brain" fallback="Brain" shape="squircle" />

</div>`}
      >
        <div className="component-specimen-row">
          <Specimen prop='shape="circle" · human'>
            <Avatar alt="Alex Lee" fallback="Alex" shape="circle" />
          </Specimen>
          <Specimen prop='shape="squircle" · agent'>
            <Avatar alt="Brain" fallback="Brain" shape="squircle" />
          </Specimen>
        </div>
      </SpecimenGroup>
      <SpecimenGroup
        label="Sizes"
        code={`<div className="flex flex-wrap items-center gap-4">

    <Avatar
      src={avatarUrl}
      alt="Morgan Martin"
      fallback="Morgan"
      size="small"
    />


    <Avatar src={avatarUrl} alt="Morgan Martin" fallback="Morgan" />


    <Avatar
      src={avatarUrl}
      alt="Morgan Martin"
      fallback="Morgan"
      size="large"
    />

</div>`}
      >
        <div className="component-specimen-row">
          <Specimen prop='size="small"'>
            <Avatar
              src={avatarUrl}
              alt="Morgan Martin"
              fallback="Morgan"
              size="small"
            />
          </Specimen>
          <Specimen prop='size="default"'>
            <Avatar src={avatarUrl} alt="Morgan Martin" fallback="Morgan" />
          </Specimen>
          <Specimen prop='size="large"'>
            <Avatar
              src={avatarUrl}
              alt="Morgan Martin"
              fallback="Morgan"
              size="large"
            />
          </Specimen>
        </div>
      </SpecimenGroup>
      <SpecimenGroup
        label="Status badge and rounded cutout"
        code={`<div className="flex flex-wrap items-center gap-4">
  {(["tiny", "compact", "small", "default", "large"] as const).map((size) => (

      <Avatar
        src={avatarUrl}
        alt="Morgan Martin"
        fallback="Morgan"
        size={size}
        statusBadge="online"
      />

  ))}
  {(["away", "offline"] as const).map((status) => (

      <Avatar
        src={avatarUrl}
        alt="Morgan Martin"
        fallback="Morgan"
        size="large"
        statusBadge={status}
      />

  ))}

    <Avatar
      src={avatarUrl}
      alt="Morgan Martin"
      fallback="Morgan"
      size="large"
    />

</div>`}
      >
        <div className="component-specimen-row">
          {(["tiny", "compact", "small", "default", "large"] as const).map(
            (size) => (
              <Specimen key={size} prop={`${size} · online`}>
                <Avatar
                  src={avatarUrl}
                  alt="Morgan Martin"
                  fallback="Morgan"
                  size={size}
                  statusBadge="online"
                />
              </Specimen>
            ),
          )}
          {(["away", "offline"] as const).map((status) => (
            <Specimen key={status} prop={`large · ${status}`}>
              <Avatar
                src={avatarUrl}
                alt="Morgan Martin"
                fallback="Morgan"
                size="large"
                statusBadge={status}
              />
            </Specimen>
          ))}
          <Specimen prop="large · no badge">
            <Avatar
              src={avatarUrl}
              alt="Morgan Martin"
              fallback="Morgan"
              size="large"
            />
          </Specimen>
        </div>
      </SpecimenGroup>
      <SpecimenGroup
        label="Agent shape (proposed)"
        code={`<div className="flex flex-wrap items-center gap-4">
  {(["tiny", "compact", "small", "default", "large"] as const).map((size) => (

      <Avatar
        src={avatarUrl}
        alt="Agent artwork"
        fallback="Agent"
        shape="squircle"
        size={size}
        statusBadge="online"
      />

  ))}
  {(["away", "offline"] as const).map((status) => (

      <Avatar
        src={avatarUrl}
        alt="Agent artwork"
        fallback="Agent"
        shape="squircle"
        size="large"
        statusBadge={status}
      />

  ))}

    <Avatar
      src={avatarUrl}
      alt="Agent artwork"
      fallback="Agent"
      shape="squircle"
    />


    <Avatar alt="Agent fallback" fallback="Agent" shape="squircle" />

</div>`}
      >
        <div className="component-specimen-row">
          {(["tiny", "compact", "small", "default", "large"] as const).map(
            (size) => (
              <Specimen key={size} prop={`squircle · ${size} · online`}>
                <Avatar
                  src={avatarUrl}
                  alt="Agent artwork"
                  fallback="Agent"
                  shape="squircle"
                  size={size}
                  statusBadge="online"
                />
              </Specimen>
            ),
          )}
          {(["away", "offline"] as const).map((status) => (
            <Specimen key={status} prop={`squircle · large · ${status}`}>
              <Avatar
                src={avatarUrl}
                alt="Agent artwork"
                fallback="Agent"
                shape="squircle"
                size="large"
                statusBadge={status}
              />
            </Specimen>
          ))}
          <Specimen prop='shape="squircle"'>
            <Avatar
              src={avatarUrl}
              alt="Agent artwork"
              fallback="Agent"
              shape="squircle"
            />
          </Specimen>
          <Specimen prop='shape="squircle", no src'>
            <Avatar alt="Agent fallback" fallback="Agent" shape="squircle" />
          </Specimen>
        </div>
      </SpecimenGroup>
      <LiveAvatarStatusSpecimen />
      {/* No `src`, so the fallback initial shows. Same three sizes, because a
          fallback has to hold the ramp as well as an image does. */}
      <SpecimenGroup
        label="Fallback, with no src"
        code={`<div className="flex flex-wrap items-center gap-4">

    <Avatar alt="Cynthia Chen" fallback="Cynthia" size="small" />


    <Avatar alt="Cynthia Chen" fallback="Cynthia" />


    <Avatar alt="Cynthia Chen" fallback="Cynthia" size="large" />

</div>`}
      >
        <div className="component-specimen-row">
          <Specimen prop='size="small"'>
            <Avatar alt="Cynthia Chen" fallback="Cynthia" size="small" />
          </Specimen>
          <Specimen prop='size="default"'>
            <Avatar alt="Cynthia Chen" fallback="Cynthia" />
          </Specimen>
          <Specimen prop='size="large"'>
            <Avatar alt="Cynthia Chen" fallback="Cynthia" size="large" />
          </Specimen>
        </div>
      </SpecimenGroup>
      <SpecimenGroup
        label="Fallback, after image failure"
        code={`<Avatar
  src="data:image/png;base64,broken"
  alt="Morgan Martin"
  fallback="Morgan"
/>`}
      >
        <Specimen prop="failed image">
          <Avatar
            src="data:image/png;base64,broken"
            alt="Morgan Martin"
            fallback="Morgan"
          />
        </Specimen>
      </SpecimenGroup>
      <SpecimenGroup
        label="Profile buttons"
        code={`<div className="flex flex-wrap items-center gap-4">
  <IconButton
    aria-label="View Morgan profile"
    size="large"
    icon={
      <Avatar src={avatarUrl} alt="" fallback="Morgan" size="fill" />
    }
  />
  <IconButton
    aria-label="View Alex profile"
    size="large"
    icon={<Avatar alt="" fallback="Alex" size="fill" />}
  />
</div>`}
      >
        <div className="component-specimen-row">
          <IconButton
            aria-label="View Morgan profile"
            size="large"
            icon={
              <Avatar src={avatarUrl} alt="" fallback="Morgan" size="fill" />
            }
          />
          <IconButton
            aria-label="View Alex profile"
            size="large"
            icon={<Avatar alt="" fallback="Alex" size="fill" />}
          />
        </div>
      </SpecimenGroup>
      <SpecimenGroup
        label="Fill an owning layout box"
        code={`<div className="size-40 overflow-hidden rounded-2xl">
  <Avatar
    src={avatarUrl}
    alt="Morgan Martin"
    fallback="Morgan"
    size="fill"
  />
</div>`}
      >
        <div className="size-40 overflow-hidden rounded-2xl">
          <Avatar
            src={avatarUrl}
            alt="Morgan Martin"
            fallback="Morgan"
            size="fill"
          />
        </div>
      </SpecimenGroup>
    </div>
  );
}

function LiveAvatarStatusSpecimen() {
  const [status, setStatus] = useState<
    "online" | "away" | "offline" | undefined
  >();
  return (
    <SpecimenGroup
      label="Status transitions"
      code={`<div className="flex flex-wrap items-center gap-4">
  <Avatar
    src={avatarUrl}
    alt="Live agent artwork"
    fallback="Agent"
    shape="squircle"
    size="large"
    statusBadge={status}
  />
  {(["online", "away", "offline"] as const).map((next) => (
    <Button key={next} size="compact" onClick={() => setStatus(next)}>
      Set {next}
    </Button>
  ))}
  <Button size="compact" onClick={() => setStatus(undefined)}>
    Clear status
  </Button>
</div>`}
    >
      <div className="component-specimen-row">
        <Avatar
          src={avatarUrl}
          alt="Live agent artwork"
          fallback="Agent"
          shape="squircle"
          size="large"
          statusBadge={status}
        />
        {(["online", "away", "offline"] as const).map((next) => (
          <Button key={next} size="compact" onClick={() => setStatus(next)}>
            Set {next}
          </Button>
        ))}
        <Button size="compact" onClick={() => setStatus(undefined)}>
          Clear status
        </Button>
      </div>
    </SpecimenGroup>
  );
}
function FullPageSurfaceSpecimen() {
  return (
    <div className="component-specimen-stack">
      <SpecimenGroup
        label="Single full-workspace surface"
        code={`<div className="w-full h-64 p-workspace-inset rounded-panel bg-app">
  <FullPageSurface aria-label="Full page surface" style={{ height: "100%" }} />
</div>`}
      >
        <div className="component-single-surface-demo">
          <FullPageSurface aria-label="Full page surface" />
        </div>
      </SpecimenGroup>
    </div>
  );
}

function PanelSpecimen() {
  return (
    <div className="component-specimen-stack">
      <Panel as="div" shape="card" aria-label="Account card surface">
        <div className="p-8">Standalone account card</div>
      </Panel>
      <Panel as="div" shape="capsule" aria-label="Capsule surface">
        <div className="p-2">Shell control group</div>
      </Panel>
      <SpecimenGroup
        label="Panel — the surface by itself"
        code={`<div className="w-full h-64 p-workspace-inset rounded-panel bg-app">
  <Panel aria-label="Panel surface" style={{ height: "100%" }} />
</div>`}
      >
        {/* No invented header or copy inside this specimen. Panel owns a surface,
            not what a product chooses to put on it, so an empty Panel is the
            honest live component. The gradient is the surrounding context it is
            designed to sit on, not content supplied by the specimen. */}
        <div className="component-single-surface-demo">
          <Panel aria-label="Panel surface" />
        </div>
      </SpecimenGroup>
    </div>
  );
}

/**
 * The parts of Tabs, per variant.
 *
 * Two lists rather than one, because the interesting fact is that the *same*
 * parts are drawn differently — the container and the tab carry no fill at all
 * in `panel`, and the indicator changes from a pill to a bar.
 */
const TABS_CHROME_PARTS = [
  {
    name: "Container",
    selector: ".buzz-tabs",
    show: ["background", "shadow", "blur", "radius"],
    note: "The glass material: fill, blur, and rim arrive together as glass-primary.",
  },
  {
    name: "Selection",
    selector: ".buzz-tabs-indicator",
    show: ["background", "shadow", "radius"],
    note: "An opaque pill behind the selected tab. Opaque because on glass, elevation reads as less translucency.",
  },
  {
    name: "Selected tab",
    selector: ".buzz-tabs-tab[data-selected]",
    show: ["color", "background"],
    note: "Draws no fill of its own — the pill behind it is the selection.",
  },
  {
    name: "Unselected tab",
    selector: ".buzz-tabs-tab:not([data-selected])",
    show: ["color", "background"],
  },
] as const;

const TABS_PANEL_PARTS = [
  {
    name: "Container",
    selector: ".buzz-tabs",
    show: ["background", "shadow", "blur", "radius"],
    note: "Nothing drawn. On a panel the tabs are text and the bar is the only mark.",
  },
  {
    name: "Selection",
    selector: ".buzz-tabs-indicator",
    show: ["background", "radius"],
    note: "A 2px bar on the bottom edge, spanning the selected tab.",
  },
  {
    name: "Selected tab",
    selector: ".buzz-tabs-tab[data-selected]",
    show: ["color", "background"],
    note: "Same size as unselected — selection is colour and the bar, never weight, which would reflow the row.",
  },
  {
    name: "Unselected tab",
    selector: ".buzz-tabs-tab:not([data-selected])",
    show: ["color", "background"],
  },
] as const;

function TabsSpecimen() {
  const [closable, setClosable] = useState([
    "Thread",
    "Profile",
    "Harness log",
  ]);
  const [selectedClosable, setSelectedClosable] = useState("Thread");
  const [attentionRequest, requestAttention] = useState(0);
  const [destination, setDestination] = useState<Destination>("messages");
  const [panelDestination, setPanelDestination] =
    useState<Destination>("messages");
  const [iconDestination, setIconDestination] = useState<Destination>("home");
  const iconItems = DESTINATIONS.map((item) => ({
    ...item,
    icon: <ChatCircleIcon size={16} aria-hidden="true" />,
  }));
  return (
    <div className="component-specimen-stack">
      <Tabs
        label="Segmented filters"
        variant="segmented"
        value={panelDestination}
        onValueChange={setPanelDestination}
        items={DESTINATIONS}
      />
      <Tabs
        label="Capsule filters"
        variant="capsule"
        value={panelDestination}
        onValueChange={setPanelDestination}
        items={DESTINATIONS}
        trailingAction={<Button variant="subtle">Filter action</Button>}
      />
      <Tabs
        label="Small segmented filters"
        variant="segmented"
        size="sm"
        value={panelDestination}
        onValueChange={setPanelDestination}
        items={DESTINATIONS}
      />
      <Tabs
        label="Dock destinations"
        variant="dock"
        value={panelDestination}
        onValueChange={setPanelDestination}
        items={iconItems.map((item, index) => ({
          ...item,
          trailing:
            index === 0 ? (
              <CountBadge count={12} label="12 items" />
            ) : undefined,
        }))}
      />
      <Tabs
        label="Icon segmented filters"
        variant="segmented-icons"
        value={panelDestination}
        onValueChange={setPanelDestination}
        items={iconItems}
      />
      <Button
        disabled={!closable.includes("Thread")}
        onClick={() => {
          setSelectedClosable("Thread");
          requestAttention((value) => value + 1);
        }}
      >
        Reopen thread
      </Button>
      <SpecimenGroup
        label="Closable navigation tabs — shared sidebar control"
        code={`{closable.length ? (
  <Tabs
    value={selectedClosable}
    label="Open details"
    variant="navigation"
    onValueChange={setSelectedClosable}
    items={closable.map((label) => ({
      value: label,
      label,
      icon:
        label === "Profile" ? (
          <Avatar alt="" fallback="Ada" size="fill" />
        ) : (
          <ChatCircleIcon size={18} />
        ),
      onClose: () => {
        const next = closable.filter((item) => item !== label);
        setClosable(next);
        if (selectedClosable === label)
          setSelectedClosable(next[0] ?? "");
      },
    }))}
    renderPanel={(value) => (
      <p className="text-body-sm">{value} content</p>
    )}
  />
) : (
  <Button
    onClick={() => {
      setClosable(["Thread", "Profile", "Harness log"]);
      setSelectedClosable("Thread");
    }}
  >
    Reset tabs
  </Button>
)}`}
      >
        {closable.length ? (
          <Tabs
            value={selectedClosable}
            label="Open details"
            variant="navigation"
            onValueChange={setSelectedClosable}
            items={closable.map((label) => ({
              value: label,
              label,
              attentionRequest:
                label === "Thread" ? attentionRequest : undefined,
              icon:
                label === "Profile" ? (
                  <Avatar alt="" fallback="Ada" size="fill" />
                ) : (
                  <ChatCircleIcon size={18} />
                ),
              onClose: () => {
                const next = closable.filter((item) => item !== label);
                setClosable(next);
                if (selectedClosable === label)
                  setSelectedClosable(next[0] ?? "");
              },
            }))}
            renderPanel={(value) => (
              <p className="text-body-sm">{value} content</p>
            )}
          />
        ) : (
          <Button
            onClick={() => {
              setClosable(["Thread", "Profile", "Harness log"]);
              setSelectedClosable("Thread");
            }}
          >
            Reset tabs
          </Button>
        )}
      </SpecimenGroup>
      <SpecimenGroup
        label="Workspace — quiet title tabs for a combined pane"
        code={`<Tabs
  value={iconDestination}
  items={DESTINATIONS}
  label="Workspace panes"
  onValueChange={setIconDestination}
  variant="workspace"
/>`}
      >
        <Tabs
          value={iconDestination}
          items={DESTINATIONS}
          label="Workspace panes"
          onValueChange={setIconDestination}
          variant="workspace"
        />
      </SpecimenGroup>

      <section className="component-specimen-group">
        <h2 className="text-label text-primary">
          Chrome — a glass pill, for the app backdrop
        </h2>
        <SpecimenFrame
          backdrop
          code={`<div data-anatomy="tabs-chrome">
  <Tabs
    value={destination}
    items={DESTINATIONS}
    label="Prototype destinations"
    onValueChange={setDestination}
  />
</div>`}
        >
          <div data-anatomy="tabs-chrome">
            <Tabs
              value={destination}
              items={DESTINATIONS}
              label="Prototype destinations"
              onValueChange={setDestination}
            />
          </div>
        </SpecimenFrame>
        <ComponentAnatomy
          scope='[data-anatomy="tabs-chrome"]'
          caption="Which token draws each part of the chrome variant, read from the specimen above."
          parts={TABS_CHROME_PARTS}
        />
      </section>
      {/* On a panel rather than the backdrop, because that is the whole point of
          the variant — and because this specimen showing only the chrome version
          on only the gradient is why the panel failure went unnoticed until it
          appeared on a real page. */}
      <section className="component-specimen-group">
        <h2 className="text-label text-primary">
          Panel — an underline, for a plain surface
        </h2>
        <SpecimenFrame
          code={`<div data-anatomy="tabs-panel">
  <Tabs
    value={panelDestination}
    items={DESTINATIONS}
    label="Prototype destinations on a panel"
    renderPanel={(value) => (
      <p className="text-body-sm">{value} content</p>
    )}
    onValueChange={setPanelDestination}
    variant="panel"
  />
</div>`}
        >
          <div data-anatomy="tabs-panel">
            <Tabs
              value={panelDestination}
              items={DESTINATIONS}
              label="Prototype destinations on a panel"
              renderPanel={(value) => (
                <p className="text-body-sm">{value} content</p>
              )}
              onValueChange={setPanelDestination}
              variant="panel"
            />
          </div>
        </SpecimenFrame>
        <ComponentAnatomy
          scope='[data-anatomy="tabs-panel"]'
          caption="The same parts in the panel variant. The container and the tab draw nothing at all, which is what makes this legible on a plain surface: there is no second fill to collide with the first."
          parts={TABS_PANEL_PARTS}
        />
      </section>
      <section className="component-specimen-group">
        <h2 className="text-label text-primary">
          Chrome, with icons and a trailing action outside the selection
        </h2>
        <SpecimenFrame
          backdrop
          code={`<Tabs
  value={iconDestination}
  items={iconItems}
  label="Prototype destinations with icons"
  onValueChange={setIconDestination}
  trailingAction={
    <IconButton
      aria-label="Create"
      icon={<PlusIcon size={16} aria-hidden="true" />}
      size="compact"
    />
  }
/>`}
        >
          <Tabs
            value={iconDestination}
            items={iconItems}
            label="Prototype destinations with icons"
            onValueChange={setIconDestination}
            trailingAction={
              <IconButton
                aria-label="Create"
                icon={<PlusIcon size={16} aria-hidden="true" />}
                size="compact"
              />
            }
          />
        </SpecimenFrame>
      </section>
    </div>
  );
}

function PanelHeaderSpecimen() {
  const actions = (
    <IconButton
      aria-label="More conversation actions"
      icon={<DotsThreeIcon size={16} aria-hidden="true" />}
      size="compact"
    />
  );
  return (
    <div className="component-specimen-stack">
      {/* PanelHeader is the header row itself — optional icon, title, and actions.
          Panel is intentionally not wrapped around it: Panel owns the surface and
          PanelHeader owns neither its container nor the content below it. The end
          control is the existing IconButton component, composed through `actions`
          rather than rebuilt as a raw button. */}
      <SpecimenGroup
        label="Default — icon, title, and IconButton action"
        code={`<PanelHeader
  title="Conversation"
  icon={<ChatCircleIcon size={16} aria-hidden="true" />}
  actions={actions}
/>`}
      >
        <PanelHeader
          title="Conversation"
          icon={<ChatCircleIcon size={16} aria-hidden="true" />}
          actions={actions}
        />
      </SpecimenGroup>
      <SpecimenGroup
        label="Detail — back navigation before the title"
        code={`<PanelHeader
  title="Profile"
  navigation={
    <IconButton
      size="toolbar"
      aria-label="Back to thread"
      icon={<ArrowLeftIcon size={18} aria-hidden="true" />}
    />
  }
  actions={actions}
/>`}
      >
        <PanelHeader
          title="Profile"
          navigation={
            <IconButton
              size="toolbar"
              aria-label="Back to thread"
              icon={<ArrowLeftIcon size={18} aria-hidden="true" />}
            />
          }
          actions={actions}
        />
      </SpecimenGroup>
      <SpecimenGroup
        label="Static identity — aligned with navigation tabs"
        code={`<PanelHeader
  title={
    <PanelHeaderLabel
      title="Conversation"
      icon={<ChatCircleIcon size="1rem" />}
    />
  }
  actions={actions}
/>`}
      >
        <PanelHeader
          title={
            <PanelHeaderLabel
              title="Conversation"
              icon={<ChatCircleIcon size="1rem" />}
            />
          }
          actions={actions}
        />
      </SpecimenGroup>
      <SpecimenGroup
        label="Media detail — compact label without an icon"
        code={`<PanelHeader
  title={<PanelHeaderLabel title="Image" />}
  actions={actions}
/>`}
      >
        <PanelHeader
          title={<PanelHeaderLabel title="Image" />}
          actions={actions}
        />
      </SpecimenGroup>
      <SpecimenGroup
        label="Floating card — truncating identity without a separator"
        code={
          '<PanelHeader variant="card" title={<PanelHeaderLabel title="Agent name" />} actions={actions} />'
        }
      >
        <PanelHeader
          variant="card"
          title={
            <PanelHeaderLabel title="An agent with a long descriptive name" />
          }
          actions={actions}
        />
      </SpecimenGroup>
      <SpecimenGroup
        label="Compact — title and IconButton action"
        code={`<PanelHeader variant="compact" title="Thread" actions={actions} />`}
      >
        <PanelHeader variant="compact" title="Thread" actions={actions} />
      </SpecimenGroup>
    </div>
  );
}

function DisclosureHeadingSpecimen() {
  const [open, setOpen] = useState(true);
  return (
    <div className="component-navigation-section-demo">
      <NavigationSectionHeading
        disclosure
        revealActions
        actions={
          <>
            <IconButton
              size="compact"
              aria-label="Workspace options"
              icon={<DotsThreeIcon size={16} aria-hidden="true" />}
            />
            <IconButton
              size="compact"
              aria-label="New chat in Work"
              icon={<PlusIcon size={16} aria-hidden="true" />}
            />
          </>
        }
      >
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          Work with a long workspace name that truncates
          <span data-navigation-reveal="" aria-hidden="true">
            <CaretDownIcon size={12} />
          </span>
        </button>
      </NavigationSectionHeading>
      {open && (
        <>
          <NavigationItem label="Launch plan" />
          <NavigationItem label="Design review" />
        </>
      )}
    </div>
  );
}

function NavigationSectionSpecimen() {
  return (
    <div className="component-specimen-stack">
      <SpecimenGroup
        label='label="Pinned", with rows as children'
        code={`<div className="w-full max-w-sm">
  <NavigationSection label="Pinned">
    <NavigationItem
      label="buzz-design"
      icon={<HashIcon size={16} aria-hidden="true" />}
    />
    <NavigationItem
      label="desktop-new"
      icon={<HashIcon size={16} aria-hidden="true" />}
    />
  </NavigationSection>
</div>`}
      >
        <div className="component-navigation-section-demo">
          <NavigationSection label="Pinned">
            <NavigationItem
              label="buzz-design"
              icon={<HashIcon size={16} aria-hidden="true" />}
            />
            <NavigationItem
              label="desktop-new"
              icon={<HashIcon size={16} aria-hidden="true" />}
            />
          </NavigationSection>
        </div>
      </SpecimenGroup>
      <SpecimenGroup
        label="Two sections adjacent — the gap between them is the grouping"
        code={`<div className="w-full max-w-sm">
  <NavigationSection label="Projects">
    <NavigationItem label="berd-main" />
  </NavigationSection>
  <NavigationSection label="Personal">
    <NavigationItem label="design-system" />
  </NavigationSection>
</div>`}
      >
        <div className="component-navigation-section-demo">
          <NavigationSection label="Projects">
            <NavigationItem label="berd-main" />
          </NavigationSection>
          <NavigationSection label="Personal">
            <NavigationItem label="design-system" />
          </NavigationSection>
        </div>
      </SpecimenGroup>
      <SpecimenGroup
        label="Disclosure heading — the label fills, actions hug and reveal on hover or focus"
        code={`<NavigationSectionHeading
  disclosure
  revealActions
  actions={<>
    <IconButton size="compact" aria-label="Workspace options" icon={…} />
    <IconButton size="compact" aria-label="New chat in Work" icon={…} />
  </>}
>
  <button type="button" aria-expanded={open} onClick={toggle}>
    Work
    <span data-navigation-reveal="" aria-hidden="true">{caret}</span>
  </button>
</NavigationSectionHeading>`}
      >
        <DisclosureHeadingSpecimen />
      </SpecimenGroup>
    </div>
  );
}

function SidebarNavigationSpecimen() {
  return (
    <div className="component-specimen-stack">
      <SpecimenGroup
        label="Main’s compact sidebar appearance — one composition in every host"
        code={`<SidebarNavigation>
  <NavigationSection>
    <NavigationItem label="community.example" />
  </NavigationSection>
  <NavigationSection label="Community">
    <NavigationItem label="Messages" selected />
    <NavigationItem label="Agents" />
    <NavigationItem label="Unavailable" disabled />
  </NavigationSection>
  <NavigationSection label="App">
    <NavigationItem label="Appearance" />
  </NavigationSection>
</SidebarNavigation>`}
      >
        <div className="component-navigation-section-demo">
          <SidebarNavigation>
            <NavigationSection>
              <NavigationItem
                label="community.example"
                aria-label="Copy community URL, community.example"
                icon={<GlobeIcon size={18} aria-hidden="true" />}
              />
            </NavigationSection>
            <NavigationSection label="Community">
              <NavigationItem
                label="Messages"
                selected
                icon={<HashIcon size={16} />}
              />
              <NavigationItem label="Agents" icon={<HashIcon size={16} />} />
              <NavigationItem
                label="Unavailable"
                disabled
                icon={<HashIcon size={16} />}
              />
            </NavigationSection>
            <NavigationSection label="App">
              <NavigationItem
                label="Appearance"
                icon={<HashIcon size={16} />}
              />
            </NavigationSection>
          </SidebarNavigation>
        </div>
      </SpecimenGroup>
    </div>
  );
}

function NavigationItemSpecimen() {
  const [selected, setSelected] = useState("buzz-design");
  const [selectedPill, setSelectedPill] = useState("Notes");
  const [dropTarget, setDropTarget] = useState(false);
  return (
    <div className="component-specimen-stack">
      {/* Interactive: clicking moves `selected`, so the selected fill and the
          unselected rest state are both visible at once and comparable. */}
      <SpecimenGroup
        label="Selected, and trailing for metadata — click to move the selection"
        code={`<div className="w-full max-w-sm">
  <NavigationItem
    label="buzz-design"
    icon={<HashIcon size={16} aria-hidden="true" />}
    selected={selected === "buzz-design"}
    onClick={() => setSelected("buzz-design")}
  />
  <NavigationItem
    label="desktop-new"
    icon={<HashIcon size={16} aria-hidden="true" />}
    trailing={<span className="text-body-sm">3</span>}
    selected={selected === "desktop-new"}
    onClick={() => setSelected("desktop-new")}
  />
</div>`}
      >
        <div className="component-navigation-section-demo">
          <NavigationItem
            label="buzz-design"
            icon={<HashIcon size={16} aria-hidden="true" />}
            selected={selected === "buzz-design"}
            onClick={() => setSelected("buzz-design")}
          />
          <NavigationItem
            label="desktop-new"
            icon={<HashIcon size={16} aria-hidden="true" />}
            trailing={<span className="text-body-sm">3</span>}
            selected={selected === "desktop-new"}
            onClick={() => setSelected("desktop-new")}
          />
        </div>
      </SpecimenGroup>
      <SpecimenGroup
        label="Card — selected item in a collection"
        code={`<NavigationCard>
  <NavigationItem label="Selected draft" selected aria-current="true" />
</NavigationCard>`}
      >
        <div className="component-navigation-section-demo">
          <NavigationCard>
            <NavigationItem
              label="Selected draft"
              selected
              aria-current="true"
            />
            <IconButton
              aria-label="Delete selected draft"
              variant="bare"
              icon={<TrashIcon size={16} />}
            />
          </NavigationCard>
          <NavigationItem
            label="Selected sent message"
            selected
            aria-current="true"
          />
        </div>
      </SpecimenGroup>
      <SpecimenGroup
        label="Card — multiline destination and independent detail action"
        code={`<NavigationCard tone="tonal" footer={<Button size="sm">View details</Button>}>
  <NavigationItem label="A destination with supporting text" multiline selected />
</NavigationCard>`}
      >
        <div className="component-navigation-section-demo">
          <NavigationCard
            tone="tonal"
            footer={<Button size="sm">View details</Button>}
          >
            <NavigationItem
              label={
                <>
                  Session interaction model
                  <br />
                  <span className="text-body-sm text-metadata">
                    Waiting for your review
                  </span>
                </>
              }
              multiline
              selected={selected === "card"}
              onClick={() => setSelected("card")}
            />
          </NavigationCard>
        </div>
      </SpecimenGroup>
      <SpecimenGroup
        label="Nested cards — hover takes priority over selected shading"
        code={`<SidebarNavigation>
<NavigationCard tone="inset" body={<NavigationCard tone="tonal">…</NavigationCard>}>
  <NavigationItem label="Project Lead" />
</NavigationCard>
</SidebarNavigation>`}
      >
        <Button
          size="sm"
          aria-pressed={dropTarget}
          onClick={() => setDropTarget(!dropTarget)}
        >
          Toggle drop destination
        </Button>
        <div className="component-navigation-section-demo">
          <SidebarNavigation>
            <NavigationCard
              tone="inset"
              data-drop-target={dropTarget || undefined}
              body={
                <>
                  <NavigationCard tone="tonal">
                    <NavigationItem
                      label="Member task"
                      selected={selected === "member"}
                      onClick={() => setSelected("member")}
                    />
                  </NavigationCard>
                  <NavigationCard tone="tonal">
                    <NavigationItem
                      label="Sibling task"
                      selected={selected === "sibling"}
                      onClick={() => setSelected("sibling")}
                    />
                  </NavigationCard>
                </>
              }
            >
              <NavigationItem
                label="Project Lead"
                selected={selected === "lead"}
                onClick={() => setSelected("lead")}
              />
            </NavigationCard>
          </SidebarNavigation>
        </div>
      </SpecimenGroup>
      <SpecimenGroup
        label="Picker option — transient highlight and immediate hover feedback"
        code={`<div className="w-full max-w-sm">
  <NavigationItem
    variant="option"
    label="Alex"
    highlighted
    icon={<Avatar fallback="Alex" alt="" size="default" />}
  />
  <NavigationItem
    variant="option"
    label="Unavailable"
    disabled
    icon={<Avatar fallback="Unavailable" alt="" size="default" />}
  />
</div>`}
      >
        <div className="component-navigation-section-demo">
          <NavigationItem
            variant="option"
            label="Alex"
            highlighted
            icon={<Avatar fallback="Alex" alt="" size="default" />}
          />
          <NavigationItem
            variant="option"
            label="Unavailable"
            disabled
            icon={<Avatar fallback="Unavailable" alt="" size="default" />}
          />
        </div>
      </SpecimenGroup>
      <SpecimenGroup
        label="Inset — one level of nesting under a row"
        code={`<div className="w-full max-w-sm">
  <NavigationItem
    label="Session interaction model"
    icon={<ChatCircleIcon size={16} aria-hidden="true" />}
    inset
    selected={selected === "session"}
    onClick={() => setSelected("session")}
  />
</div>`}
      >
        <div className="component-navigation-section-demo">
          <NavigationItem
            label="Session interaction model"
            icon={<ChatCircleIcon size={16} aria-hidden="true" />}
            inset
            selected={selected === "session"}
            onClick={() => setSelected("session")}
          />
        </div>
      </SpecimenGroup>
      <SpecimenGroup
        label="Pill — click to move the selection"
        code={`<div className="flex flex-wrap items-center gap-4">
  {["Notes", "Activity"].map((label) => (
    <NavigationItem
      key={label}
      label={label}
      variant="pill"
      selected={selectedPill === label}
      onClick={() => setSelectedPill(label)}
    />
  ))}
</div>`}
      >
        <div className="component-specimen-row">
          {["Notes", "Activity"].map((label) => (
            <NavigationItem
              key={label}
              label={label}
              variant="pill"
              selected={selectedPill === label}
              onClick={() => setSelectedPill(label)}
            />
          ))}
        </div>
      </SpecimenGroup>
      <SpecimenGroup
        label="Chrome route navigation (not tabs)"
        code={`<nav aria-label="Destinations" className="chrome-navigation">
  <NavigationItem label="Me" variant="pill" selected />
  <NavigationItem label="Messages" variant="pill" />
</nav>`}
      >
        <nav aria-label="Destinations" className="chrome-navigation">
          {["Me", "Messages"].map((label) => (
            <NavigationItem
              key={label}
              label={label}
              variant="pill"
              selected={selectedPill === label}
              onClick={() => setSelectedPill(label)}
            />
          ))}
        </nav>
      </SpecimenGroup>
    </div>
  );
}

const CHIP_PERSON: ChipAddress = { kind: "person", id: "pk-morgan" };
const CHIP_AGENT: ChipAddress = { kind: "agent", id: "pk-morgarita" };
const CHIP_CHANNEL: ChipAddress = { kind: "channel", id: "ch-buzz-team" };
const CHIP_MESSAGE: ChipAddress = { kind: "message", id: "ev-thread-root" };
const CHIP_LINK: ChipAddress = {
  kind: "link",
  id: "https://github.com/block/buzz",
};
const CHIP_UNRESOLVED: ChipAddress = {
  kind: "person",
  id: "9f2c4a1b7e5d8306a4b2c1d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9",
};
const CHIP_LONG: ChipAddress = { kind: "person", id: "pk-long" };

const CHIP_KIND_ROWS = [
  { label: "Person", address: CHIP_PERSON },
  { label: "Agent", address: CHIP_AGENT },
  { label: "Channel", address: CHIP_CHANNEL },
  { label: "Message", address: CHIP_MESSAGE },
  { label: "Link", address: CHIP_LINK },
] as const;

/**
 * Seeds faces so the specimens show resolved chips. The product resolves these
 * from real identity; the page only needs the shapes to be visible.
 */
function seedChipFaces() {
  chipFaces.put(CHIP_PERSON, {
    label: "Morgan Martin",
    loading: false,
    resolved: true,
  });
  chipFaces.put(CHIP_AGENT, {
    label: "Morgarita",
    loading: false,
    resolved: true,
  });
  chipFaces.put(CHIP_CHANNEL, {
    label: "buzz-team",
    loading: false,
    resolved: true,
  });
  chipFaces.put(CHIP_MESSAGE, {
    label: "buzz-team",
    loading: false,
    resolved: true,
  });
  chipFaces.put(CHIP_LINK, {
    label: "github.com/block/buzz",
    loading: false,
    resolved: true,
  });
  chipFaces.put(CHIP_LONG, {
    label: "A deliberately very long display name that must truncate",
    loading: false,
    resolved: true,
  });
}

function PreviewCardSpecimen() {
  return (
    <div className="component-specimen-stack">
      <SpecimenGroup
        label="Default"
        code={`<p className="text-body text-primary">
  <PreviewCard
    trigger={
      <button type="button" className="buzz-preview-card-example">
        Morgan Martin
      </button>
    }
  >
    <span className="buzz-preview-card-kind text-body-sm text-tertiary">
      Person
    </span>
    <span className="buzz-preview-card-name text-body text-primary">
      Morgan Martin
    </span>
    <span className="text-body-sm text-secondary">
      Product designer
    </span>
  </PreviewCard>{" "}
  is reviewing the first Composer composition.
</p>`}
      >
        <p className="text-body text-primary">
          <PreviewCard
            trigger={
              <button type="button" className="buzz-preview-card-example">
                Morgan Martin
              </button>
            }
          >
            <span className="buzz-preview-card-kind text-body-sm text-tertiary">
              Person
            </span>
            <span className="buzz-preview-card-name text-body text-primary">
              Morgan Martin
            </span>
            <span className="text-body-sm text-secondary">
              Product designer
            </span>
          </PreviewCard>{" "}
          is reviewing the first Composer composition.
        </p>
      </SpecimenGroup>
    </div>
  );
}

function InlineChipSpecimen() {
  const [activated, setActivated] = useState<string | null>(null);
  seedChipFaces();

  return (
    <div className="component-specimen-stack">
      <SpecimenGroup
        label="Kinds"
        code={`<div className="flex flex-wrap items-center gap-4">
  {CHIP_KIND_ROWS.map((row) => (

      <InlineChip address={row.address} />

  ))}
</div>`}
      >
        {/* Caption under the sample, not in a fixed-width column beside it: a
            label column wide enough for `kind: "channel"` left the link chip
            nowhere to truncate and pushed it off a 380px viewport. */}
        <div className="component-specimen-row">
          {CHIP_KIND_ROWS.map((row) => (
            <Specimen key={row.label} prop={`kind: "${row.address.kind}"`}>
              <InlineChip address={row.address} />
            </Specimen>
          ))}
        </div>
      </SpecimenGroup>

      <SpecimenGroup
        label="In a sentence"
        code={`<p className="text-body text-primary">
  Asked <InlineChip address={CHIP_PERSON} /> and{" "}
  <InlineChip address={CHIP_AGENT} /> to look at{" "}
  <InlineChip address={CHIP_MESSAGE} /> in{" "}
  <InlineChip address={CHIP_CHANNEL} />, alongside{" "}
  <InlineChip address={CHIP_LINK} /> before the review.
</p>`}
      >
        <p className="text-body text-primary">
          Asked <InlineChip address={CHIP_PERSON} /> and{" "}
          <InlineChip address={CHIP_AGENT} /> to look at{" "}
          <InlineChip address={CHIP_MESSAGE} /> in{" "}
          <InlineChip address={CHIP_CHANNEL} />, alongside{" "}
          <InlineChip address={CHIP_LINK} /> before the review.
        </p>
      </SpecimenGroup>

      <SpecimenGroup
        label="Resolved preview"
        code={`<p className="text-body text-primary">
  Hover or focus <InlineChip address={CHIP_PERSON} /> to reveal its
  quiet preview. It supplies context without opening another surface.
</p>`}
      >
        <p className="text-body text-primary">
          Hover or focus <InlineChip address={CHIP_PERSON} /> to reveal its
          quiet preview. It supplies context without opening another surface.
        </p>
      </SpecimenGroup>

      <SpecimenGroup
        label="Inert rendering"
        code={`<p className="text-body text-primary">
  Use an inert chip when the surface cannot show reference details:{" "}
  <InlineChip address={CHIP_PERSON} interactive={false} />
</p>`}
      >
        <p className="text-body text-primary">
          Use an inert chip when the surface cannot show reference details:{" "}
          <InlineChip address={CHIP_PERSON} interactive={false} />
        </p>
      </SpecimenGroup>

      <SpecimenGroup
        label="Unresolved reference"
        code={`<div className="flex flex-col gap-3">
  <div className="flex flex-wrap items-center gap-4">
    <InlineChip address={CHIP_UNRESOLVED} />
  </div>
  <p className="max-w-md text-body-sm text-tertiary">
    An unresolved chip has no name or destination. It stays inert and
    announces its unresolved state without reading an identity fragment.
  </p>
</div>`}
      >
        <div className="flex flex-col gap-3">
          <div className="component-specimen-row">
            <InlineChip address={CHIP_UNRESOLVED} />
          </div>
          <p className="max-w-md text-body-sm text-tertiary">
            An unresolved chip has no name or destination. It stays inert and
            announces its unresolved state without reading an identity fragment.
          </p>
        </div>
      </SpecimenGroup>

      <SpecimenGroup
        label="Resolving mention"
        code={`<p className="text-body text-primary">
  Ask{" "}
  <InlineChip
    address={{ kind: "agent", id: "pending-1" }}
    face={{ label: "Example", loading: true, resolved: false }}
    interactive={false}
  />{" "}
  while the recipient is still being decided.
</p>`}
      >
        <div className="flex flex-col gap-3">
          <p className="text-body text-primary">
            Ask{" "}
            <InlineChip
              address={{ kind: "agent", id: "pending-1" }}
              face={{ label: "Example", loading: true, resolved: false }}
              interactive={false}
            />{" "}
            while the recipient is still being decided.
          </p>
          <p className="max-w-md text-body-sm text-tertiary">
            The spinner sits in the sigil&apos;s box, so the chip does not move
            when it settles into a recipient or back into text.
          </p>
        </div>
      </SpecimenGroup>

      <SpecimenGroup
        label="Long label truncates"
        code={`<div className="flex flex-wrap items-center gap-4">
  <InlineChip address={CHIP_LONG} />
</div>`}
      >
        <div className="component-specimen-row">
          <InlineChip address={CHIP_LONG} />
        </div>
      </SpecimenGroup>

      <SpecimenGroup
        label="Wrapping across lines"
        code={`<p className="max-w-xs text-body text-primary">
  A chip sits in the text flow, so a line break falls before or after it
  and never inside it: <InlineChip address={CHIP_PERSON} />{" "}
  <InlineChip address={CHIP_AGENT} /> <InlineChip address={CHIP_LINK} />
</p>`}
      >
        <p className="max-w-xs text-body text-primary">
          A chip sits in the text flow, so a line break falls before or after it
          and never inside it: <InlineChip address={CHIP_PERSON} />{" "}
          <InlineChip address={CHIP_AGENT} /> <InlineChip address={CHIP_LINK} />
        </p>
      </SpecimenGroup>

      <SpecimenGroup
        label="Activation"
        code={`<div className="flex flex-wrap items-center gap-4">
  <InlineChip
    address={CHIP_PERSON}
    onActivate={(address) => setActivated(address.id)}
  />
  <span className="text-body-sm text-tertiary">
    {activated ? \`Opened \${activated}\` : "Not activated"}
  </span>
</div>`}
      >
        <div className="component-specimen-row">
          <InlineChip
            address={CHIP_PERSON}
            onActivate={(address) => setActivated(address.id)}
          />
          <span className="text-body-sm text-tertiary">
            {activated ? `Opened ${activated}` : "Not activated"}
          </span>
        </div>
      </SpecimenGroup>
    </div>
  );
}

const LONG_MODEL =
  "claude-sonnet-5-5-extended-context-thinking-preview-2026-10";

function SwitchSpecimen() {
  const [checked, setChecked] = useState(false);
  const [busyChecked, setBusyChecked] = useState(true);
  const [selected, setSelected] = useState(false);
  const [managed, setManaged] = useState(false);
  const checkboxId = useId();
  return (
    <SpecimenFrame
      code={`<div className="flex flex-col gap-8">
  <div className="divide-y divide-line">
    <SwitchPreferenceRow
      icon={<ChatCircleIcon size={20} />}
      label="Desktop alerts"
      description="Show notifications for new activity."
      checked={checked}
      onCheckedChange={setChecked}
    />
    <SwitchPreferenceRow label="Sound" checked />
    <SwitchPreferenceRow
      label="Unavailable preference"
      icon={<ChatCircleIcon size={20} />}
      disabled
    />
    <PreferenceRow
      icon={<HashIcon size={20} />}
      title="Include archived channels"
      subtitle="Include archived channels when browsing your saved conversations. This longer explanation wraps while the control stays aligned."
      controlId={checkboxId}
      trailing={(labelProps) => (
        <Checkbox
          {...labelProps}
          id={checkboxId}
          label={null}
          checked={selected}
          onCheckedChange={setSelected}
        />
      )}
    />
    <PreferenceRow
      title="Connected accounts"
      subtitle={
        managed
          ? "Account management opened."
          : "Manage the accounts connected to this workspace."
      }
      trailing={
        <Button size="sm" onClick={() => setManaged(!managed)}>
          {managed ? "Done" : "Manage"}
        </Button>
      }
    />
    <PreferenceRow
      title="Channels"
      trailing={<span className="text-body-sm text-subtle">Required</span>}
    />
    <PreferenceRow
      title="Model"
      trailing={
        <Select
          variant="compact"
          label="Model"
          value="long"
          groups={[{ label: "", options: [{ value: "long", label: LONG_MODEL }] }]}
          onValueChange={() => {}}
        />
      }
    />
  </div>
  <Switch
    checked={checked}
    onCheckedChange={setChecked}
    label="Show agent activity"
  />
  <Switch checked label="Show agent activity" />
  <Switch disabled label="Show agent activity" />
  <div className="flex flex-wrap items-center gap-4">
    <span className="text-body">Plugin enabled (saving)</span>
    <Switch
      checked={busyChecked}
      onCheckedChange={setBusyChecked}
      readOnly
      aria-disabled="true"
      aria-label="Enable busy plugin"
    />
  </div>
</div>`}
    >
      <div className="component-specimen-stack">
        <div className="divide-y divide-line">
          <SwitchPreferenceRow
            icon={<ChatCircleIcon size={20} />}
            label="Desktop alerts"
            description="Show notifications for new activity."
            checked={checked}
            onCheckedChange={setChecked}
          />
          <SwitchPreferenceRow label="Sound" checked />
          <SwitchPreferenceRow
            label="Unavailable preference"
            icon={<ChatCircleIcon size={20} />}
            disabled
          />
          <PreferenceRow
            icon={<HashIcon size={20} />}
            title="Include archived channels"
            subtitle="Include archived channels when browsing your saved conversations. This longer explanation wraps while the control stays aligned."
            controlId={checkboxId}
            trailing={(labelProps) => (
              <Checkbox
                {...labelProps}
                id={checkboxId}
                label={null}
                checked={selected}
                onCheckedChange={setSelected}
              />
            )}
          />
          <PreferenceRow
            title="Connected accounts"
            subtitle={
              managed
                ? "Account management opened."
                : "Manage the accounts connected to this workspace."
            }
            trailing={
              <Button size="sm" onClick={() => setManaged(!managed)}>
                {managed ? "Done" : "Manage"}
              </Button>
            }
          />
          <PreferenceRow
            title="Channels"
            trailing={
              <span className="text-body-sm text-subtle">Required</span>
            }
          />
          {/* A long value ellipsizes before the title loses its words. */}
          <PreferenceRow
            title="Model"
            trailing={
              <Select
                variant="compact"
                label="Model"
                value="long"
                groups={[
                  {
                    label: "",
                    options: [{ value: "long", label: LONG_MODEL }],
                  },
                ]}
                onValueChange={() => {}}
              />
            }
          />
        </div>
        <Switch
          checked={checked}
          onCheckedChange={setChecked}
          label="Show agent activity"
        />
        <Switch checked label="Show agent activity" />
        <Switch disabled label="Show agent activity" />
        <div className="component-specimen-row">
          <span className="text-body">Plugin enabled (saving)</span>
          <Switch
            checked={busyChecked}
            onCheckedChange={setBusyChecked}
            readOnly
            aria-disabled="true"
            aria-label="Enable busy plugin"
          />
        </div>
      </div>
    </SpecimenFrame>
  );
}

function AlertDialogSpecimen() {
  const [open, setOpen] = useState(false);
  return (
    <SpecimenFrame
      code={`<Button onClick={() => setOpen(true)}>Discard example changes</Button>
{open && (
  <AlertDialog
    title="Discard changes?"
    description="Your unsaved example changes will be lost."
    onClose={() => setOpen(false)}
    actions={
      <>
        <Button onClick={() => setOpen(false)}>Keep editing</Button>
        <Button variant="destructive" onClick={() => setOpen(false)}>
          Discard
        </Button>
      </>
    }
  />
)}`}
    >
      <Button onClick={() => setOpen(true)}>Discard example changes</Button>
      {open && (
        <AlertDialog
          title="Discard changes?"
          description="Your unsaved example changes will be lost."
          onClose={() => setOpen(false)}
          actions={
            <>
              <Button onClick={() => setOpen(false)}>Keep editing</Button>
              <Button variant="destructive" onClick={() => setOpen(false)}>
                Discard
              </Button>
            </>
          }
        />
      )}
    </SpecimenFrame>
  );
}

function RadioGroupSpecimen() {
  const [summary, setSummary] = useState(false);
  const [delivery, setDelivery] = useState("all");
  const [enabled, setEnabled] = useState(false);
  return (
    <>
      <SpecimenGroup
        label="Compact choices"
        code={`<Field label="Status">
  <RadioGroup size="sm" defaultValue="any">
    <Radio size="sm" value="any" label="Any status" />
    <Radio size="sm" value="enabled" label="Enabled" />
    <Radio size="sm" value="disabled" label="Disabled" disabled />
  </RadioGroup>
</Field>`}
      >
        <Field label="Status">
          <RadioGroup size="sm" defaultValue="any">
            <Radio size="sm" value="any" label="Any status" />
            <Radio size="sm" value="enabled" label="Enabled" />
            <Radio size="sm" value="disabled" label="Disabled" disabled />
          </RadioGroup>
        </Field>
      </SpecimenGroup>
      <SpecimenGroup
        label="Text-only tiles"
        code={`<Field label="Delivery" nativeLabel={false}>
  <RadioGroup defaultValue="all">
    <Radio value="all" label="All updates" variant="tile" />
    <Radio value="mentions" label="Mentions only" variant="tile" />
    <Radio value="none" label="Unavailable" variant="tile" disabled />
  </RadioGroup>
</Field>`}
      >
        <Field label="Delivery" nativeLabel={false}>
          <RadioGroup defaultValue="all">
            <Radio value="all" label="All updates" variant="tile" />
            <Radio value="mentions" label="Mentions only" variant="tile" />
            <Radio value="none" label="Unavailable" variant="tile" disabled />
          </RadioGroup>
        </Field>
      </SpecimenGroup>
      <SpecimenGroup
        label="Native form reset"
        code={`<form aria-label="Notification preferences">
  <Field label="Notifications">
    <RadioGroup name="notifications" defaultValue="all">
      <Radio value="all" label="All updates" variant="card" />
      <Radio value="mentions" label="Mentions only" variant="card" />
      <Radio value="none" label="Unavailable" disabled />
    </RadioGroup>
  </Field>
  <Checkbox
    name="summary"
    value="yes"
    label="Include a summary"
    defaultChecked
  />
  <Button type="reset">Reset preferences</Button>
</form>`}
      >
        <form aria-label="Notification preferences">
          <Field label="Notifications">
            <RadioGroup name="notifications" defaultValue="all">
              <Radio value="all" label="All updates" variant="card" />
              <Radio value="mentions" label="Mentions only" variant="card" />
              <Radio value="none" label="Unavailable" disabled />
            </RadioGroup>
          </Field>
          <Checkbox
            name="summary"
            value="yes"
            label="Include a summary"
            defaultChecked
          />
          <Button type="reset">Reset preferences</Button>
        </form>
      </SpecimenGroup>
      <SpecimenGroup
        label="Controlled form reset"
        code={`<form aria-label="Controlled preferences">
  <Field label="Delivery">
    <RadioGroup
      name="delivery"
      value={delivery}
      onValueChange={setDelivery}
    >
      <Radio value="all" label="All updates" />
      <Radio value="mentions" label="Mentions only" />
    </RadioGroup>
  </Field>
  <Checkbox
    name="summary"
    value="yes"
    label="Include a summary"
    checked={summary}
    onCheckedChange={setSummary}
  />
  <Button type="reset">Reset preferences</Button>
</form>`}
      >
        <form aria-label="Controlled preferences">
          <Field label="Delivery">
            <RadioGroup
              name="delivery"
              value={delivery}
              onValueChange={setDelivery}
            >
              <Radio value="all" label="All updates" />
              <Radio value="mentions" label="Mentions only" />
            </RadioGroup>
          </Field>
          <Checkbox
            name="summary"
            value="yes"
            label="Include a summary"
            checked={summary}
            onCheckedChange={setSummary}
          />
          <Button type="reset">Reset preferences</Button>
        </form>
      </SpecimenGroup>
      <SpecimenGroup
        label="Initially disabled choices"
        code={`<form aria-label="Deferred preferences">
  <Button onClick={() => setEnabled(true)} disabled={enabled}>
    Enable choices
  </Button>
  <Field label="Delivery">
    <RadioGroup
      name="delivery"
      defaultValue="all"
      disabled={!enabled}
    >
      <Radio value="all" label="All updates" />
      <Radio value="mentions" label="Mentions only" />
    </RadioGroup>
  </Field>
  <Button type="reset">Reset preferences</Button>
</form>`}
      >
        <form aria-label="Deferred preferences">
          <Button onClick={() => setEnabled(true)} disabled={enabled}>
            Enable choices
          </Button>
          <Field label="Delivery">
            <RadioGroup name="delivery" defaultValue="all" disabled={!enabled}>
              <Radio value="all" label="All updates" />
              <Radio value="mentions" label="Mentions only" />
            </RadioGroup>
          </Field>
          <Button type="reset">Reset preferences</Button>
        </form>
      </SpecimenGroup>
    </>
  );
}

function LoadingRegionSpecimen() {
  const [pending, setPending] = useState(false);
  return (
    <SpecimenFrame
      code={`<LoadingRegion pending={pending} label="Refreshing…">
  <Input aria-label="Existing name" defaultValue="Saved name" />
</LoadingRegion>`}
    >
      <Button onClick={() => setPending((value) => !value)}>
        {pending ? "Complete read" : "Begin read"}
      </Button>
      <LoadingRegion pending={pending} label="Refreshing…">
        <Input aria-label="Existing name" defaultValue="Saved name" />
      </LoadingRegion>
      <LoadingRegion
        pending={pending}
        label="Refreshing quiet name…"
        statusVisibility="screen-reader"
      >
        <Input aria-label="Quiet name" defaultValue="Saved name" />
      </LoadingRegion>
    </SpecimenFrame>
  );
}

export const COMPONENT_SPECIMENS: Record<string, () => ReactNode> = {
  "loading-region": LoadingRegionSpecimen,
  "alert-dialog": AlertDialogSpecimen,
  dialog: DialogSpecimens,
  toast: ToastSpecimens,
  tooltip: () => (
    <div className="component-specimen-stack">
      <SpecimenFrame
        code={`<Tooltip content="Create a note">
  <IconButton aria-label="Create note" icon={<PlusIcon size={16} />} />
</Tooltip>`}
      >
        <Tooltip content="Create a note">
          <IconButton aria-label="Create note" icon={<PlusIcon size={16} />} />
        </Tooltip>
      </SpecimenFrame>
      <SpecimenGroup
        label="Pointer-attached hint — keeps the native cursor"
        code={`<Tooltip follow="pointer" content="Copy">
  <Button variant="ghost">community.example</Button>
</Tooltip>`}
      >
        <Tooltip follow="pointer" content="Copy">
          <Button variant="ghost">community.example</Button>
        </Tooltip>
      </SpecimenGroup>
    </div>
  ),
  field: () => (
    <SpecimenFrame
      code={`<Field
  label="Workspace name"
  description="Choose a name your team will recognize."
  error="Enter a name."
>
  <Input required />
</Field>
<Field label="Workspace description" error="Enter a description.">
  <Textarea id="workspace-description" required rows={3} />
</Field>`}
    >
      <Field
        label="Workspace name"
        description="Choose a name your team will recognize."
        error="Enter a name."
      >
        <Input required />
      </Field>
      <Field label="Workspace description" error="Enter a description.">
        <Textarea id="workspace-description" required rows={3} />
      </Field>
    </SpecimenFrame>
  ),
  calendar: CalendarSpecimen,
  "field-button": FieldButtonSpecimen,
  input: InputExamples,
  textarea: TextareaExamples,
  "radio-group": RadioGroupSpecimen,
  checkbox: () => (
    <SpecimenFrame
      code={`<Checkbox label="Include a summary" />
<Checkbox label="Some selected" indeterminate />
<Checkbox label="Unavailable" disabled />
<Checkbox size="sm" label="Compact choice" />
<Checkbox size="sm" label="Compact mixed" indeterminate />
<Checkbox size="sm" label="Compact unavailable" disabled />`}
    >
      <Checkbox label="Include a summary" />
      <Checkbox label="Some selected" indeterminate />
      <Checkbox label="Unavailable" disabled />
      <Checkbox size="sm" label="Compact choice" />
      <Checkbox size="sm" label="Compact mixed" indeterminate />
      <Checkbox size="sm" label="Compact unavailable" disabled />
    </SpecimenFrame>
  ),
  "swap-workspace": PanelSwapPlaygrounds,
  "flex-workspace": FlexWorkspace,
  workspace: BentoSpecimen,
  button: ButtonSpecimen,
  "icon-button": IconButtonSpecimen,
  "split-button": SplitButtonSpecimen,
  avatar: AvatarSpecimen,
  "avatar-stack": AvatarStackSpecimen,
  "shimmer-text": ShimmerTextSpecimen,
  "typing-dots": TypingDotsSpecimen,
  "preview-card": PreviewCardSpecimen,
  "inline-chip": InlineChipSpecimen,
  "full-page-surface": FullPageSurfaceSpecimen,
  panel: PanelSpecimen,
  tabs: TabsSpecimen,
  menu: MenuSpecimen,
  popover: PopoverSpecimen,
  "choice-row": ChoiceRowSpecimen,
  select: SelectExamples,
  combobox: ComboboxExamples,
  switch: SwitchSpecimen,
  "settings-group": () => (
    <div className="grid gap-8">
      <div>
        <InlineHeader title="Notifications" />
        <SettingsGroup>
          <SwitchPreferenceRow label="Desktop alerts" defaultChecked />
          <SwitchPreferenceRow
            label="Sound"
            description="Choose a sound to preview it."
            defaultChecked
          />
          <PreferenceRow
            title="Direct messages"
            trailing={<Button size="sm">Flutter</Button>}
          />
        </SettingsGroup>
      </div>
      <div>
        <InlineHeader title="Profile" />
        <SettingsGroup layout="form">
          <Field label="Display name" optional>
            <Input defaultValue="Alex" />
          </Field>
          <Field label="Folder" nativeLabel={false}>
            <FieldButton dropdown={false}>~/Development/project</FieldButton>
          </Field>
          <div className="flex justify-end">
            <Button>Save profile</Button>
          </div>
        </SettingsGroup>
      </div>
      <div>
        <InlineHeader title="Attached folders" />
        <SettingsGroup layout="cards">
          <PreferenceRow title="Project" subtitle="~/Development/project" />
          <PreferenceRow title="Reference" subtitle="~/Documents/reference" />
        </SettingsGroup>
      </div>
    </div>
  ),
  "theme-picker": ThemePickerSpecimen,
  "count-badge": () => (
    <div className="flex w-64 flex-col gap-1">
      <NavigationItem
        label="Drafts & sent"
        trailing={<CountBadge count={5} label="5 drafts" />}
      />
      <NavigationItem
        label="Drafts & sent"
        selected
        trailing={<CountBadge count={42} label="42 drafts" />}
      />
      <NavigationItem
        label="Drafts & sent"
        trailing={<CountBadge count={1200} label="1200 drafts" />}
      />
    </div>
  ),
  "keyboard-shortcut": () => (
    <div className="flex flex-wrap gap-3">
      <KeyboardShortcut text="⇧⌘K" label="Shift Command K" />
      <KeyboardShortcut text="Ctrl+Shift+K" label="Control Shift K" />
    </div>
  ),
  "preference-row": SwitchSpecimen,
  accordion: () => (
    <SpecimenFrame
      code={`<Accordion
  animate
  items={[
    {
      value: "purpose",
      title: "When to use an accordion",
      content: (
        <p className="text-body">
          Use a disclosure for supporting content that does not need to be
          visible all the time.
        </p>
      ),
    },
    {
      value: "behavior",
      title: "Keyboard behavior",
      content: (
        <p className="text-body">
          Focus a heading and press Enter or Space to expand it.
        </p>
      ),
    },
  ]}
/>
<h3 className="text-label">
  Form disclosures · spacing owned by the form
</h3>
<Accordion
  variant="form"
  keepMounted
  items={[
    {
      value: "advanced",
      title: "Advanced",
      content: (
        <Field label="Label">
          <Input placeholder="Draft stays when collapsed" />
        </Field>
      ),
    },
    {
      value: "details",
      title: "Technical details",
      content: (
        <p className="text-body-sm text-subtle">
          Supporting information shares the same row rhythm.
        </p>
      ),
    },
  ]}
/>`}
    >
      <InlineHeader title="Active section" />
      <Accordion
        animate
        variant="section"
        items={[
          {
            value: "done",
            title: "Completed section",
            content: (
              <p className="text-body">
                Content aligns with adjacent sections.
              </p>
            ),
          },
        ]}
      />
      <Accordion
        items={[
          {
            value: "purpose",
            title: "When to use an accordion",
            content: (
              <p className="text-body">
                Use a disclosure for supporting content that does not need to be
                visible all the time.
              </p>
            ),
          },
          {
            value: "behavior",
            title: "Keyboard behavior",
            content: (
              <p className="text-body">
                Focus a heading and press Enter or Space to expand it.
              </p>
            ),
          },
        ]}
      />
      <Accordion
        variant="settings"
        items={[
          {
            value: "memory",
            title: "Core memory",
            content: <p className="text-body-sm">Supporting agent context.</p>,
          },
        ]}
      />
      <SettingsGroup>
        <PreferenceRow title="Public key" subtitle="npub1…" />
        <Accordion
          variant="settings"
          items={[
            {
              value: "Previous versions",
              title: "Previous versions · 3 versions",
              content: (
                <p className="text-body-sm">
                  Settings and instructions versions.
                </p>
              ),
            },
          ]}
        />
        <PreferenceRow title="Remove from this community" />
      </SettingsGroup>
      <h3 className="text-label">
        Form disclosures · spacing owned by the form
      </h3>
      <Accordion
        variant="form"
        keepMounted
        items={[
          {
            value: "advanced",
            title: "Advanced",
            content: (
              <Field label="Label">
                <Input placeholder="Draft stays when collapsed" />
              </Field>
            ),
          },
          {
            value: "details",
            title: "Technical details",
            content: (
              <p className="text-body-sm text-subtle">
                Supporting information shares the same row rhythm.
              </p>
            ),
          },
        ]}
      />
    </SpecimenFrame>
  ),
  "empty-state": () => (
    <div className="grid gap-8">
      <SpecimenFrame
        code={`<EmptyState
  icon={<SmileyIcon />}
  title="No emojis yet"
  description="Add a custom emoji to use in messages and reactions."
  action={<Button>Add emoji</Button>}
/>`}
      >
        <EmptyState
          icon={<SmileyIcon />}
          title="No emojis yet"
          description="Add a custom emoji to use in messages and reactions."
          action={<Button>Add emoji</Button>}
        />
      </SpecimenFrame>
      <SpecimenFrame
        code={`<EmptyState
  icon={<SquaresFourIcon />}
  title="No templates yet"
  description="Save a starting setup to reuse in new channels."
/>`}
      >
        <EmptyState
          icon={<SquaresFourIcon />}
          title="No templates yet"
          description="Save a starting setup to reuse in new channels."
        />
      </SpecimenFrame>
      <SpecimenFrame
        code={`<EmptyState
  frame="none"
  level={4}
  icon={<SmileyIcon />}
  title="You're all caught up"
  description="Inside a popover, the popover is the frame."
/>`}
      >
        <EmptyState
          frame="none"
          level={4}
          icon={<SmileyIcon />}
          title="You're all caught up"
          description="Inside a popover, the popover is the frame."
        />
      </SpecimenFrame>
    </div>
  ),
  header: () => (
    <SpecimenFrame
      code={`<div className="buzz-settings-page" style={{ containerType: "inline-size" }}>
  <Header
    title="Profile"
    eyebrow="Account"
    subtitle="Your local default for new communities."
  />
  <InlineHeader title="Preferences" subtitle="Choose what works for you." />
  <Header title="Communities" align="end" actions={<Button aria-label="Create community">Create</Button>} />
</div>`}
    >
      <div
        className="buzz-settings-page"
        style={{ containerType: "inline-size" }}
      >
        <Header
          title="Profile"
          eyebrow="Account"
          subtitle="Your local default for new communities."
        />
        <InlineHeader
          title="Preferences"
          subtitle="Choose what works for you."
        />
        <Header
          title="Communities"
          align="end"
          actions={<Button aria-label="Create community">Create</Button>}
        />
      </div>
    </SpecimenFrame>
  ),
  "panel-header": PanelHeaderSpecimen,
  "search-field": SearchExamples,
  composer: ComposerSpecimen,
  "sidebar-navigation": SidebarNavigationSpecimen,
  "navigation-section": NavigationSectionSpecimen,
  "navigation-item": NavigationItemSpecimen,
};
