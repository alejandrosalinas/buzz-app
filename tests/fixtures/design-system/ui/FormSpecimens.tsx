import { ExamplePreview } from "./ExamplePreview";
import { Section } from "./primitives";
import { useId, useState, type ReactNode } from "react";
import { Field } from "../../../../src/shared/design-system/ui/Field";
import { InputGroup } from "../../../../src/shared/design-system/ui/InputGroup";
import {
  CodeIcon,
  Filter2Icon,
} from "../../../../src/shared/design-system/icons";
import { Input } from "../../../../src/shared/design-system/ui/Input";
import { Textarea } from "../../../../src/shared/design-system/ui/Textarea";
import { SearchField } from "../../../../src/shared/design-system/ui/SearchField";
import { Select } from "../../../../src/shared/design-system/ui/Select";
import { Combobox } from "../../../../src/shared/design-system/ui/Combobox";
import { Button } from "../../../../src/shared/design-system/ui/Button";

import { IconButton } from "../../../../src/shared/design-system/ui/IconButton";

const destinations = [
  {
    value: "studio",
    label: "Design studio",
    description: "A shared space for design work.",
  },
  {
    value: "product",
    label: "Product team",
    description: "Planning and product decisions.",
  },
  {
    value: "research",
    label: "Research and accessibility across all workspace experiences",
    description: "A long option to check wrapping at narrow widths.",
  },
];
export const workspaceGroups = [
  {
    label: "Workspaces",
    options: destinations,
  },
  {
    label: "",
    separator: true,
    options: [
      { value: "archive", label: "Archived workspace", disabled: true },
    ],
  },
];

export function FormExample({
  title,
  description,
  code,
  children,
}: {
  title: string;
  description: string;
  code: string;
  children: ReactNode;
}) {
  return (
    <Section title={title} description={description}>
      <ExamplePreview label={title} code={code}>
        <div className="form-doc-fields">{children}</div>
      </ExamplePreview>
    </Section>
  );
}

export function InputExamples() {
  const suffixId = useId();
  return (
    <div className="component-specimen-stack">
      <FormExample
        title="Input states"
        description="One line of text. A visible label names the field; the placeholder gives an example."
        code={`<Field
  label="Workspace name"
  description="Use a name your team will recognize."
>
  <Input
    placeholder="Design studio"
    name="workspace"
    autoComplete="organization"
  />
</Field>
<Field label="Filled">
  <Input defaultValue="Design studio" />
</Field>
<Field
  label="Read-only"
  description="You can focus and copy this value."
>
  <Input readOnly value="workspace-studio" />
</Field>
<Field label="Saving" aria-busy="true">
  <Input readOnly aria-disabled="true" value="Design studio" />
</Field>
<Field label="Disabled">
  <Input disabled value="Managed by your organization" />
</Field>
<Field
  label="Invalid"
  description="Letters, spaces, and numbers are supported."
  error="Enter a workspace name."
>
  <Input required />
</Field>`}
      >
        <Field
          label="Workspace name"
          description="Use a name your team will recognize."
        >
          <Input
            placeholder="Design studio"
            name="workspace"
            autoComplete="organization"
          />
        </Field>
        <Field label="Filled">
          <Input defaultValue="Design studio" />
        </Field>
        <Field label="Site address" description="The domain stays fixed.">
          <InputGroup wrap>
            <Input
              textSize="large"
              placeholder="studio"
              aria-describedby={suffixId}
            />
            <span
              id={suffixId}
              className="min-w-0 wrap-anywhere text-body-lg text-primary"
            >
              .example.org
            </span>
          </InputGroup>
        </Field>
        <Field
          label="Read-only"
          description="You can focus and copy this value."
        >
          <Input readOnly value="workspace-studio" />
        </Field>
        <Field label="Saving" aria-busy="true">
          <Input readOnly aria-disabled="true" value="Design studio" />
        </Field>
        <Field label="Disabled">
          <Input disabled value="Managed by your organization" />
        </Field>
        <Field
          label="Invalid"
          description="Letters, spaces, and numbers are supported."
          error="Enter a workspace name."
        >
          <Input required />
        </Field>
        <Field label="Image URL on a floating surface">
          <InputGroup surface="panel">
            <input type="url" placeholder="https://example.com/image.png" />
          </InputGroup>
        </Field>
      </FormExample>
    </div>
  );
}

export function TextareaExamples() {
  return (
    <div className="component-specimen-stack">
      <FormExample
        title="Textarea states"
        description="Multiple lines of prose retain manual vertical resizing. The resize grip sits inside the rounded corner. Code uses the existing mono variant."
        code={`<Field
  label="Description"
  description="Explain what this workspace is for."
>
  <Textarea
    rows={3}
    placeholder="A place to explore and share ideas."
  />
</Field>
<Field label="On a floating surface">
  <Textarea surface="panel" rows={3} placeholder="Describe what I should do" />
</Field>
<Field label="Read-only notes">
  <Textarea
    rows={3}
    readOnly
    value="This record is available to read and copy."
  />
</Field>
<Field label="Disabled notes">
  <Textarea rows={3} disabled value="Editing is unavailable." />
</Field>
<Field label="Required notes" error="Add a short description.">
  <Textarea rows={3} required />
</Field>
<Field
  label="Configuration"
  description="The feature owns parsing and saving."
>
  <Textarea
    variant="code"
    rows={4}
    spellCheck={false}
    defaultValue={"name: design-studio\\nenabled: true"}
  />
</Field>`}
      >
        <Field label="Outlined instructions">
          <Textarea
            appearance="outlined"
            rows={3}
            placeholder="Describe what I should do"
          />
        </Field>
        <Field label="On a floating surface">
          <Textarea
            surface="panel"
            rows={3}
            placeholder="Describe what I should do"
          />
        </Field>
        <Field
          label="Description"
          description="Explain what this workspace is for."
        >
          <Textarea
            rows={3}
            placeholder="A place to explore and share ideas."
          />
        </Field>
        <Field label="Read-only notes">
          <Textarea
            rows={3}
            readOnly
            value="This record is available to read and copy."
          />
        </Field>
        <Field label="Disabled notes">
          <Textarea rows={3} disabled value="Editing is unavailable." />
        </Field>
        <Field label="Required notes" error="Add a short description.">
          <Textarea rows={3} required />
        </Field>
        <Field
          label="Configuration"
          description="The feature owns parsing and saving."
        >
          <Textarea
            variant="code"
            rows={4}
            spellCheck={false}
            defaultValue={"name: design-studio\nenabled: true"}
          />
        </Field>
      </FormExample>
    </div>
  );
}

export function SearchExamples() {
  const [query, setQuery] = useState("");
  const [filled, setFilled] = useState("design");
  const [invalid, setInvalid] = useState("unknown");
  return (
    <div className="component-specimen-stack">
      <FormExample
        title="Search with a trailing action"
        description="Search and its filter action share one frame; Clear remains separate."
        code={
          '<SearchField value={query} onValueChange={setQuery} trailing={<IconButton aria-label="Filter" icon={<Filter2Icon />} />} />'
        }
      >
        <SearchField
          value={query}
          onValueChange={setQuery}
          trailing={
            <IconButton aria-label="Filter" icon={<Filter2Icon size={16} />} />
          }
        />
      </FormExample>
      <FormExample
        title="Search palette"
        description="Composer surface, generous input spacing, and larger search text."
        code={
          '<SearchField variant="palette" value={query} onValueChange={setQuery} />'
        }
      >
        <SearchField variant="palette" value={query} onValueChange={setQuery} />
      </FormExample>
      <FormExample
        title="Search and clear"
        description="The accessible label stays present even when visually hidden. Clearing returns focus to the input; its action slot stays the same width."
        code={`<SearchField
  label="Search workspaces"
  placeholder="Search workspaces"
  value={query}
  onValueChange={setQuery}
  description="Type to filter the workspaces below."
/>
<p role="status" className="text-body-sm text-subtle">
  {destinations
    .filter((item) =>
      item.label.toLowerCase().includes(query.toLowerCase()),
    )
    .map((item) => item.label)
    .join(" · ") || "No workspaces match. Try a different name."}
</p>
<SearchField
  label="Filled search"
  value={filled}
  onValueChange={setFilled}
  description="Clear the query to start a new search."
/>
<SearchField
  label="Read-only search"
  readOnly
  value="design"
  onValueChange={() => {}}
/>
<SearchField
  label="Disabled search"
  disabled
  value="design"
  onValueChange={() => {}}
/>
<SearchField
  label="Search with error"
  value={invalid}
  onValueChange={setInvalid}
  error="Search is unavailable. Try again when connected."
/>`}
      >
        <SearchField
          label="Search workspaces"
          placeholder="Search workspaces"
          value={query}
          onValueChange={setQuery}
          description="Type to filter the workspaces below."
        />
        <p role="status" className="text-body-sm text-subtle">
          {destinations
            .filter((item) =>
              item.label.toLowerCase().includes(query.toLowerCase()),
            )
            .map((item) => item.label)
            .join(" · ") || "No workspaces match. Try a different name."}
        </p>
        <SearchField
          label="Filled search"
          value={filled}
          onValueChange={setFilled}
          description="Clear the query to start a new search."
        />
        <SearchField
          label="Read-only search"
          readOnly
          value="design"
          onValueChange={() => {}}
        />
        <SearchField
          label="Disabled search"
          disabled
          value="design"
          onValueChange={() => {}}
        />
        <SearchField
          label="Search with error"
          value={invalid}
          onValueChange={setInvalid}
          error="Search is unavailable. Try again when connected."
        />
      </FormExample>
    </div>
  );
}

export function SelectExamples() {
  const [value, setValue] = useState("");
  const [inline, setInline] = useState("studio");
  return (
    <div className="component-specimen-stack">
      <FormExample
        title="Select states"
        description="Choose from a finite list. Use the field variant in forms; keep inline choices for compact filters. Open the list to see selected and unavailable options."
        code={`<Select
  label="Workspace"
  variant="field"
  name="workspace"
  placeholder="Choose a workspace"
  required
  value={value}
  onValueChange={setValue}
  groups={workspaceGroups}
  description="Choose where this item belongs."
/>
<Select
  label="Read-only workspace"
  variant="field"
  readOnly
  value="studio"
  onValueChange={() => {}}
  groups={workspaceGroups}
/>
<Select
  label="Disabled workspace"
  variant="field"
  disabled
  value="studio"
  onValueChange={() => {}}
  groups={workspaceGroups}
/>
<Select
  label="Invalid workspace"
  variant="field"
  value=""
  placeholder="Choose a workspace"
  onValueChange={() => {}}
  groups={workspaceGroups}
  error="Choose an available workspace."
/>
<Select
  label="Filter"
  value={inline}
  onValueChange={setInline}
  groups={workspaceGroups}
/>
<div style={{ maxWidth: 160 }}>
  <Select
    label="Row workspace"
    leading={<CodeIcon size={20} />}
    variant="compact"
    align="end"
    value={inline}
    onValueChange={setInline}
    groups={workspaceGroups}
  />
</div>`}
      >
        <Select
          label="Workspace"
          variant="field"
          name="workspace"
          placeholder="Choose a workspace"
          required
          value={value}
          onValueChange={setValue}
          groups={workspaceGroups}
          description="Choose where this item belongs."
        />
        <Select
          label="Filled workspace"
          variant="compact"
          appearance="inverted"
          value={value}
          onValueChange={setValue}
          groups={workspaceGroups}
        />
        <Select
          label="Read-only workspace"
          variant="field"
          readOnly
          value="studio"
          onValueChange={() => {}}
          groups={workspaceGroups}
        />
        <Select
          label="Disabled workspace"
          variant="field"
          disabled
          value="studio"
          onValueChange={() => {}}
          groups={workspaceGroups}
        />
        <Select
          label="Invalid workspace"
          variant="field"
          value=""
          placeholder="Choose a workspace"
          onValueChange={() => {}}
          groups={workspaceGroups}
          error="Choose an available workspace."
        />
        <Select
          label="Filter"
          value={inline}
          onValueChange={setInline}
          groups={workspaceGroups}
        />
        <Select
          label="Text link choice"
          variant="compact"
          appearance="link"
          value={inline}
          onValueChange={setInline}
          groups={workspaceGroups}
        />
        <Select
          label="Input-height filter"
          variant="compact"
          size="md"
          leading={<CodeIcon size={20} />}
          align="end"
          value={inline}
          onValueChange={setInline}
          groups={workspaceGroups}
        />
        <div style={{ maxWidth: 160 }}>
          <Select
            label="Row workspace"
            leading={<CodeIcon size={20} />}
            variant="compact"
            align="end"
            value={inline}
            onValueChange={setInline}
            groups={workspaceGroups}
          />
        </div>
        <Select
          label="Card workspace"
          valueSuffix=" · Default"
          variant="compact"
          appearance="glass-ghost"
          leading={<CodeIcon size={16} aria-hidden="true" />}
          value={inline}
          onValueChange={setInline}
          groups={workspaceGroups}
        />
      </FormExample>
      <FormExample
        title="Disabled choices"
        description="Unavailable choices keep the same disabled text and caret whether showing a value or a placeholder."
        code={`<Select label="Thinking" variant="preference" disabled
  value="" placeholder="Unavailable" groups={workspaceGroups}
  onValueChange={() => {}} />`}
      >
        {(["field", "inline", "compact", "preference"] as const).map(
          (variant) => (
            <div key={variant}>
              <Select
                label={`${variant} placeholder`}
                variant={variant}
                disabled
                value=""
                placeholder="Unavailable"
                groups={workspaceGroups}
                onValueChange={() => {}}
              />
              <Select
                label={`${variant} value`}
                variant={variant}
                disabled
                value="studio"
                groups={workspaceGroups}
                onValueChange={() => {}}
              />
            </div>
          ),
        )}
      </FormExample>
    </div>
  );
}

type ExampleState = "ready" | "loading" | "empty" | "error";
export function WorkspaceCombobox({
  label = "Find a workspace",
  state = "ready",
  disabled = false,
  readOnly = false,
  compact = false,
}: {
  label?: string;
  state?: ExampleState;
  disabled?: boolean;
  readOnly?: boolean;
  compact?: boolean;
}) {
  const [value, setValue] = useState<(typeof destinations)[number] | null>(
    null,
  );
  const items = state === "ready" ? destinations : [];
  return (
    <Combobox.Root
      items={items}
      value={value}
      onValueChange={setValue}
      disabled={disabled}
      readOnly={readOnly}
      itemToStringLabel={(item) => item.label}
    >
      <Combobox.Control
        appearance={compact ? "chip" : "field"}
        label={label}
        triggerLabel={`Browse ${label.toLowerCase()}`}
        placeholder="Search workspaces"
        loading={state === "loading"}
        description={
          state === "loading" ? (
            <span role="status">Loading workspaces…</span>
          ) : (
            "Type to filter, or browse the list."
          )
        }
        error={
          state === "error"
            ? "Workspaces could not be loaded. Retry below."
            : undefined
        }
      />
      <Combobox.Popup
        empty={
          state === "loading"
            ? "Loading workspaces…"
            : state === "error"
              ? "Unable to load workspaces."
              : "No workspaces match. Try another name."
        }
      >
        <Combobox.List>
          {(item: (typeof destinations)[number]) => (
            <Combobox.Item
              key={item.value}
              value={item}
              description={item.description}
            >
              {item.label}
            </Combobox.Item>
          )}
        </Combobox.List>
      </Combobox.Popup>
    </Combobox.Root>
  );
}

function PopupSearchExample({ compact = false }: { compact?: boolean }) {
  const options = compact
    ? [
        "Anthropic",
        "Databricks",
        "OpenAI",
        "Google",
        "Mistral",
        "Ollama",
        "OpenRouter",
        "xAI",
      ]
    : ["Anthropic", "Databricks", "OpenAI"];
  const [value, setValue] = useState<string | null>("Databricks");
  const [query, setQuery] = useState("");
  return (
    <Combobox.Root
      items={options}
      value={value}
      onValueChange={setValue}
      inputValue={query}
      onInputValueChange={setQuery}
      onOpenChange={(open) => {
        if (open) setQuery("");
      }}
      autoHighlight
    >
      <Combobox.Trigger
        label={compact ? "Compact provider picker" : "Provider"}
      >
        {value ?? "Choose a provider"}
      </Combobox.Trigger>
      <Combobox.Popup
        search
        size={compact ? "compact" : "default"}
        side="bottom"
        collisionAvoidance={
          compact ? { side: "none", align: "shift" } : undefined
        }
        empty="No matching providers."
      >
        <Combobox.List>
          {(item: string) => (
            <Combobox.Item key={item} value={item}>
              {item}
            </Combobox.Item>
          )}
        </Combobox.List>
      </Combobox.Popup>
    </Combobox.Root>
  );
}

export function ComboboxExamples() {
  const [state, setState] = useState<ExampleState>("ready");
  return (
    <div className="component-specimen-stack">
      <FormExample
        title="Searchable choices"
        description="A check marks the selected value; highlighting follows the pointer or keyboard. Try a query with no matches, a long option, and Escape."
        code={`<WorkspaceCombobox />
<WorkspaceCombobox label="Compact row choice" compact />
<WorkspaceCombobox label="Read-only choices" readOnly />
<WorkspaceCombobox label="Disabled choices" disabled />

${workspaceComboboxCode}`}
      >
        <WorkspaceCombobox />
        <PopupSearchExample />
        <PopupSearchExample compact />
        <WorkspaceCombobox label="Compact row choice" compact />
        <WorkspaceCombobox label="Read-only choices" readOnly />
        <WorkspaceCombobox label="Disabled choices" disabled />
      </FormExample>
      <FormExample
        title="Loading, empty, and recovery"
        description="Choose a sample state to inspect loading or failure, then use the recovery action. These examples make no service requests. Features own requests, cancellation, and custom values."
        code={`<Select
  label="Example state"
  value={state}
  onValueChange={(value) => setState(value as ExampleState)}
  groups={[
    {
      label: "",
      options: ["ready", "loading", "empty", "error"].map((value) => ({
        value,
        label: value,
      })),
    },
  ]}
/>
<WorkspaceCombobox
  key={state}
  state={state}
  label="Workspace results"
/>
{state === "error" && (
  <Button onClick={() => setState("ready")}>Retry example</Button>
)}
{state === "loading" && (
  <Button onClick={() => setState("ready")}>Complete loading</Button>
)}

${workspaceComboboxCode}`}
      >
        <Select
          label="Example state"
          value={state}
          onValueChange={(value) => setState(value as ExampleState)}
          groups={[
            {
              label: "",
              options: ["ready", "loading", "empty", "error"].map((value) => ({
                value,
                label: value,
              })),
            },
          ]}
        />
        <WorkspaceCombobox
          key={state}
          state={state}
          label="Workspace results"
        />
        {state === "error" && (
          <Button onClick={() => setState("ready")}>Retry example</Button>
        )}
        {state === "loading" && (
          <Button onClick={() => setState("ready")}>Complete loading</Button>
        )}
      </FormExample>
    </div>
  );
}

/** Full source for examples that compose the public Combobox parts. */
export const workspaceComboboxCode = `import { IconButton } from "../../../../src/shared/design-system/ui/IconButton";

const destinations = [
  {
    value: "studio",
    label: "Design studio",
    description: "A shared space for design work.",
  },
  {
    value: "product",
    label: "Product team",
    description: "Planning and product decisions.",
  },
  {
    value: "research",
    label: "Research and accessibility across all workspace experiences",
    description: "A long option to check wrapping at narrow widths.",
  },
];

type ExampleState = "ready" | "loading" | "empty" | "error";

function WorkspaceCombobox({
  label = "Find a workspace",
  state = "ready",
  disabled = false,
  readOnly = false,
}: {
  label?: string;
  state?: ExampleState;
  disabled?: boolean;
  readOnly?: boolean;
}) {
  const [value, setValue] = useState<(typeof destinations)[number] | null>(
    null,
  );
  const items = state === "ready" ? destinations : [];
  return (
    <Combobox.Root
      items={items}
      value={value}
      onValueChange={setValue}
      disabled={disabled}
      readOnly={readOnly}
      itemToStringLabel={(item) => item.label}
    >
      <Combobox.Control
        label={label}
        triggerLabel={\`Browse \${label.toLowerCase()}\`}
        placeholder="Search workspaces"
        loading={state === "loading"}
        description={
          state === "loading" ? (
            <span role="status">Loading workspaces…</span>
          ) : (
            "Type to filter, or browse the list."
          )
        }
        error={
          state === "error"
            ? "Workspaces could not be loaded. Retry below."
            : undefined
        }
      />
      <Combobox.Popup
        empty={
          state === "loading"
            ? "Loading workspaces…"
            : state === "error"
              ? "Unable to load workspaces."
              : "No workspaces match. Try another name."
        }
      >
        <Combobox.List>
          {(item: (typeof destinations)[number]) => (
            <Combobox.Item
              key={item.value}
              value={item}
              description={item.description}
            >
              {item.label}
            </Combobox.Item>
          )}
        </Combobox.List>
      </Combobox.Popup>
    </Combobox.Root>
  );
}`;
