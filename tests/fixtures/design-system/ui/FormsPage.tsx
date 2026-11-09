import { PageHeader, Section } from "./primitives";
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Field } from "../../../../src/shared/design-system/ui/Field";
import { Input } from "../../../../src/shared/design-system/ui/Input";
import { Textarea } from "../../../../src/shared/design-system/ui/Textarea";
import { SearchField } from "../../../../src/shared/design-system/ui/SearchField";
import { Select } from "../../../../src/shared/design-system/ui/Select";
import { Button } from "../../../../src/shared/design-system/ui/Button";
import { Dialog } from "../../../../src/shared/design-system/ui/Dialog";
import {
  FormExample,
  WorkspaceCombobox,
  workspaceGroups,
  workspaceComboboxCode,
} from "./FormSpecimens";

function FormComposition() {
  const [name, setName] = useState("");
  const [workspace, setWorkspace] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [saved, setSaved] = useState(false);
  return (
    <form
      noValidate
      className="form-doc-fields"
      onSubmit={(event) => {
        event.preventDefault();
        setSubmitted(true);
        setSaved(Boolean(name.trim() && workspace));
      }}
    >
      <Field
        label="Project name"
        description="A short name for your team."
        error={submitted && !name.trim() ? "Enter a project name." : undefined}
      >
        <Input
          name="project"
          required
          value={name}
          onValueChange={(value) => {
            setName(value);
            setSaved(false);
          }}
        />
      </Field>
      <Select
        label="Destination"
        variant="field"
        name="destination"
        required
        placeholder="Choose a workspace"
        value={workspace}
        onValueChange={(value) => {
          setWorkspace(value);
          setSaved(false);
        }}
        groups={workspaceGroups}
        error={submitted && !workspace ? "Choose a destination." : undefined}
      />
      <Field label="Notes" optional>
        <Textarea rows={3} />
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="prominent">
          Save example
        </Button>
        <p role="status" className="text-body-sm text-subtle">
          {saved ? "Example saved for this preview." : "Sample data only."}
        </p>
      </div>
    </form>
  );
}

export function FormsPage() {
  const [narrow, setNarrow] = useState(false);
  const [dialog, setDialog] = useState(false);
  return (
    <>
      <PageHeader
        title="Forms"
        intro="Combine fields into a form with clear labels, helpful validation, and predictable spacing. Try the examples, then use the guidance below in your own form."
      >
        <div className="form-doc-toolbar">
          <Button aria-pressed={narrow} onClick={() => setNarrow(!narrow)}>
            {narrow ? "Full-width preview" : "Narrow preview"}
          </Button>
          <Button onClick={() => setDialog(true)}>
            Try a form in a dialog
          </Button>
        </div>
      </PageHeader>
      <div className="form-doc-preview" data-narrow={narrow}>
        <FormExample
          title="Controls together"
          description="A form groups related fields with room for labels and help. Try the narrow preview to see how controls wrap, or open the same form in a dialog."
          code={`<Field label="Name">
  <div className="flex flex-wrap items-start gap-2">
    <Input placeholder="Design studio" style={{ flex: "1 1 10rem" }} />
    <Button>Check name</Button>
  </div>
</Field>
<SearchExamplesInline />
<SelectTogether />
<WorkspaceCombobox label="Searchable destination" />
<Field label="Description">
  <Textarea
    rows={3}
    placeholder="A few words about this workspace."
  />
</Field>

function SearchExamplesInline() {
  const [value, setValue] = useState("");
  return (
    <SearchField
      label="Search workspaces"
      placeholder="Search workspaces"
      value={value}
      onValueChange={setValue}
    />
  );
}

function SelectTogether() {
  const [value, setValue] = useState("studio");
  return (
    <Select
      label="Destination"
      variant="field"
      value={value}
      onValueChange={setValue}
      groups={workspaceGroups}
    />
  );
}

${workspaceComboboxCode}`}
        >
          <Field label="Name">
            <div className="form-doc-input-action">
              <Input placeholder="Design studio" />
              <Button>Check name</Button>
            </div>
          </Field>
          <SearchExamplesInline />
          <SelectTogether />
          <WorkspaceCombobox label="Searchable destination" />
          <Field label="Description">
            <Textarea
              rows={3}
              placeholder="A few words about this workspace."
            />
          </Field>
        </FormExample>
        <Section title="Choose by the job">
          <p className="text-body text-secondary">
            Input is for one line; Textarea is for multiple lines. SearchField
            filters an existing view. Select chooses from a finite list.
            Combobox searches a set of choices; custom values are a feature
            decision.
          </p>
          <p className="text-body text-secondary">
            Use Field once per control. Select in field mode, SearchField, and
            Combobox.Control already own their label and supporting text—do not
            wrap them in another Field.
          </p>
          <div className="flex flex-wrap gap-4 text-body text-link underline">
            {[
              "input",
              "textarea",
              "search-field",
              "select",
              "combobox",
              "field",
            ].map((slug) => (
              <Link key={slug} to={`/design/components/${slug}`}>
                {slug}
              </Link>
            ))}
          </div>
        </Section>
        <FormExample
          title="Validation in a form"
          description="Save with empty fields to see validation. Then enter a project name, choose a destination, and save again. This example keeps values only while the page is open."
          code={`function FormComposition() {
  const [name, setName] = useState("");
  const [workspace, setWorkspace] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [saved, setSaved] = useState(false);
  return (
    <form
      noValidate
      className="grid min-w-0 w-full gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        setSubmitted(true);
        setSaved(Boolean(name.trim() && workspace));
      }}
    >
      <Field
        label="Project name"
        description="A short name for your team."
        error={submitted && !name.trim() ? "Enter a project name." : undefined}
      >
        <Input
          name="project"
          required
          value={name}
          onValueChange={(value) => {
            setName(value);
            setSaved(false);
          }}
        />
      </Field>
      <Select
        label="Destination"
        variant="field"
        name="destination"
        required
        placeholder="Choose a workspace"
        value={workspace}
        onValueChange={(value) => {
          setWorkspace(value);
          setSaved(false);
        }}
        groups={workspaceGroups}
        error={submitted && !workspace ? "Choose a destination." : undefined}
      />
      <Field label="Notes" optional>
        <Textarea rows={3} />
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="prominent">
          Save example
        </Button>
        <p role="status" className="text-body-sm text-subtle">
          {saved ? "Example saved for this preview." : "Sample data only."}
        </p>
      </div>
    </form>
  );
}`}
        >
          <FormComposition />
        </FormExample>
      </div>
      <Section title="Implementation rules">
        <ul className="list-disc ps-5 space-y-3 text-body text-secondary">
          <li>
            Use existing Buzz type, color, radius, and spacing roles. Default
            fields use text-body and radius-control; labels use text-label-sm.
          </li>
          <li>
            Field owns an 8px label/control/help/error gap. The form owns 16px
            between adjacent fields and 32px between named sections. Do not add
            a second gap around Field.
          </li>
          <li>
            InputGroup is the shared inline frame for icons and actions in
            SearchField and Combobox. It does not own labels, validation, or
            fetching.
          </li>
          <li>
            Keep one accessible label per control. Placeholder text is an
            example, never the only label. Connect help, errors, and
            asynchronous status to the field.
          </li>
          <li>
            Errors replace secondary helper text until resolved. The outer field
            owns the error stroke; browse and clear buttons keep their normal
            appearance.
          </li>
          <li>
            Shared fields replace the outer ring with their active 1px perimeter
            stroke, fading in and out over 150ms with ease, with one stroke
            around composite controls. Keyboard focus and reduced motion make
            this immediate. Navigation and focus restoration remain intact.
          </li>
          <li>
            Select and Combobox chevrons rotate with the open state using the
            150ms state duration and settling curve. Keyboard navigation and
            reduced motion switch their orientation immediately.
          </li>
          <li>
            Disabled means unavailable. Read-only values remain readable and
            copyable. Clearing search restores input focus.
          </li>
          <li>
            Use the shared floating surface for choices. Keep selected,
            highlighted, unavailable, loading, no-match, and failure states
            distinct. Select and Combobox popups fade, move 4px, and unblur over
            150ms, with a 120ms exit. Keyboard navigation and reduced motion
            make this immediate.
          </li>
          <li>
            Keep parsing, network requests, retry/cancel, and custom-value
            commits with the feature. Textarea preserves manual resizing and the
            existing code variant.
          </li>
        </ul>
      </Section>
      <Section title="Usage">
        <pre className="form-doc-code text-mono">
          <code>{`<Field label="Name" description="A name your team knows." error={error}>\n  <Input name="name" value={name} onValueChange={setName} required />\n</Field>\n\n<Select variant="field" label="Destination" name="destination"\n  placeholder="Choose a workspace" value={destination}\n  onValueChange={setDestination} groups={workspaceGroups} error={error} />\n\n<Combobox.Root items={items} value={selected} onValueChange={setSelected}
  itemToStringLabel={item => item.name}>\n  <Combobox.Control label="Model" triggerLabel="Browse models"\n    description="Choose or enter a model." loading={loading} />\n  <Combobox.Popup empty={loading ? "Loading…" : "No matches."}>\n    <Combobox.List>{item => (\n      <Combobox.Item key={item.id} value={item}>{item.name}</Combobox.Item>\n    )}</Combobox.List>\n  </Combobox.Popup>\n</Combobox.Root>`}</code>
        </pre>
        <p className="text-body text-secondary">
          Select field metadata: description, error, name, required, readOnly,
          placeholder; options may be disabled. Combobox.Control accepts
          description and error; set readOnly/disabled on Combobox.Root.
          SearchField accepts description/error and uses the same 12px control
          corners as other fields.
        </p>
      </Section>
      <Section title="Review in context">
        <p className="text-body text-secondary">
          Try Tab and Shift+Tab, Arrow keys, Enter, Escape, and clearing search.
          Use both themes, the narrow preview, and larger browser text/zoom. In
          the app, review agent import, agent configuration, and workflow
          editing; this page uses generic shared components, not live app data.
        </p>
        <p className="text-body text-secondary">
          Agent import inherits shared field styling. Emoji search mirrors these
          tokens inside its existing picker. Variable-name, URL, and workflow
          field errors use Field; YAML help returns when validation clears.
          Request failures and problems affecting the whole workflow remain
          separate notices.
        </p>
        <p className="text-body text-secondary">
          Auto-growing textareas, multi-select chips, and search inside a popup
          are deferred. Buzz retains its own foundations and Base UI behavior.
        </p>
      </Section>
      <Dialog
        open={dialog}
        onOpenChange={setDialog}
        title="Create a project"
        description="Check field spacing, focus, and choices inside a dialog."
      >
        <div className="form-doc-fields">
          <FormComposition />
          <WorkspaceCombobox label="Suggested workspace" />
        </div>
      </Dialog>
    </>
  );
}
function SearchExamplesInline() {
  const [value, setValue] = useState("");
  return (
    <SearchField
      label="Search workspaces"
      placeholder="Search workspaces"
      value={value}
      onValueChange={setValue}
    />
  );
}
function SelectTogether() {
  const [value, setValue] = useState("studio");
  return (
    <Select
      label="Destination"
      variant="field"
      value={value}
      onValueChange={setValue}
      groups={workspaceGroups}
    />
  );
}
