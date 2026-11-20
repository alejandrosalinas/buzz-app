// Prebuilt API v1 module: no build, dependencies, network or filesystem access.
// Uses the host's own controls from the optional `ui` service, with plain
// elements as the fallback on hosts that do not provide it.
export const inject = ["react", "pages"];

export function apply(ctx) {
  const React = ctx.react;
  const h = React.createElement;
  ctx.pages.register({
    id: "main",
    title: "Host controls playground",
    primary: true,
    component: function HostControls() {
      const ui = ctx.reflect.get("ui");
      const [open, setOpen] = React.useState(false);
      const [name, setName] = React.useState("");
      const [draft, setDraft] = React.useState("");
      const [attempted, setAttempted] = React.useState(false);
      const [alerts, setAlerts] = React.useState(false);
      const formId = React.useId();
      const summary = h(
        "p",
        null,
        name ? `Saved as ${name}.` : "No name saved yet.",
      );
      if (!ui)
        return h(
          "section",
          { style: { padding: "var(--space-panel-inset)" } },
          h("h1", null, "Host controls playground"),
          h("p", null, "This version of Buzz does not offer host controls."),
          summary,
        );
      const edit = () => {
        setDraft(name);
        setAttempted(false);
        setOpen(true);
      };
      const save = (event) => {
        event.preventDefault();
        setAttempted(true);
        if (!draft.trim()) return;
        setName(draft.trim());
        setOpen(false);
      };
      return h(
        "section",
        {
          style: {
            padding: "var(--space-panel-inset)",
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-start",
            gap: "var(--space-2)",
          },
        },
        h("h1", null, "Host controls playground"),
        summary,
        // A switch applies immediately, so it sits on the page, not behind Save.
        h(ui.Switch, {
          label: "Desktop alerts",
          checked: alerts,
          onCheckedChange: setAlerts,
        }),
        h(ui.Button, { variant: "prominent", onClick: edit }, "Edit name"),
        h(
          ui.Dialog,
          {
            open,
            onOpenChange: setOpen,
            title: "Display name",
            description:
              "Try typing, Tab, Escape, and disabling the plugin while this is open.",
            // The dialog holds a draft, so a stray click outside must not discard it.
            dismissOnOutsideClick: false,
            actions: [
              h(
                ui.Button,
                { key: "cancel", onClick: () => setOpen(false) },
                "Cancel",
              ),
              h(
                ui.Button,
                // Actions sit outside the body, so Save names the form it submits.
                {
                  key: "save",
                  variant: "prominent",
                  type: "submit",
                  form: formId,
                },
                "Save",
              ),
            ],
          },
          // A form makes Enter in the field save, like the Save action.
          h(
            "form",
            { id: formId, onSubmit: save },
            h(
              ui.Field,
              {
                label: "Name",
                error: attempted && !draft.trim() ? "Enter a name" : undefined,
              },
              h(ui.Input, {
                value: draft,
                onValueChange: setDraft,
              }),
            ),
          ),
        ),
      );
    },
  });
}
