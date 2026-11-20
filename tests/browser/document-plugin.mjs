// A single installed module: no app imports or second React/Markdown runtime.
export function documentPlugin(ctx, clipGuide = false) {
  const React = ctx.react;
  const h = React.createElement;
  function Reader({ name, session }) {
    ctx.panels.useTabTitle(name);
    const [content, setContent] = React.useState(
      `## ${name}\n\n**Host Markdown**\n\n| Status | Detail |\n| :--- | ---: |\n| Open | A long value with enough words to overflow in the narrow document pane |\n\n![Tracking image](https://tracker.example/p.gif)\n\n[Unsafe](javascript:alert%281%29)\n\n<buzz://channel/alpha>\n\n[the **alpha** room](buzz://channel/alpha)\n\n\`\`\`ts\n${Array.from({ length: 40 }, (_, line) => `const line${line} = ${line};`).join("\n")}\n\`\`\``,
    );
    const [editing, setEditing] = React.useState(false);
    const [source, setSource] = React.useState(false);
    const [linkOpen, setLinkOpen] = React.useState(false);
    const [saved, setSaved] = React.useState(0);
    const [toolbarTarget, setToolbarTarget] = React.useState(null);
    const editor = React.useRef(null);
    const documentEditor = h(ctx.conversation.ui.DocumentEditor, {
      key: editing ? "edit" : "read",
      ref: editor,
      value: content,
      onChange: setContent,
      editing,
      source,
      onSourceChange: setSource,
      linkOpen,
      onLinkOpenChange: setLinkOpen,
      maxLength: 32768,
      onSave: () => setSaved((saved) => saved + 1),
      toolbarTarget: name === "Guide" ? toolbarTarget : null,
      destinations: [
        {
          label: "Reference document",
          href: "buzz://plugin?id=example.documents&document=reference",
        },
      ],
      children: h(ctx.conversation.ui.Markdown, {
        session,
        content,
        scale: "document",
      }),
    });
    const scrollArea = h(
      "section",
      {
        "aria-label": "Document scroll area",
        style: {
          flex: 1,
          minHeight: 0,
          padding: "var(--space-panel-inset)",
          overflow: "auto",
          scrollPaddingBlockEnd: "var(--space-2)",
        },
      },
      h("input", {
        "aria-label": `${name} draft`,
        "data-tab-focus": "",
        defaultValue: "",
      }),
      h(
        "button",
        { type: "button", onClick: () => setEditing(!editing) },
        editing ? `Read ${name}` : `Edit ${name}`,
      ),
      editing &&
        h(
          "button",
          { type: "button", onClick: () => setSource(!source) },
          source ? "Rich text" : "Markdown source",
        ),
      editing &&
        h(
          "button",
          {
            type: "button",
            onClick: () => setContent("External **replacement**"),
          },
          "Replace document",
        ),
      clipGuide && name === "Guide"
        ? h(
            "section",
            {
              "aria-label": "Guide width limit",
              style: { overflowX: "hidden" },
            },
            documentEditor,
          )
        : documentEditor,
      h("p", { role: "status" }, `Saved ${saved}`),
    );
    return h(
      "article",
      {
        style: {
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
          minWidth: 0,
        },
      },
      scrollArea,
      name === "Guide" &&
        editing &&
        !source &&
        h("div", {
          ref: setToolbarTarget,
          style: { margin: "0 var(--space-4) var(--space-4)" },
        }),
    );
  }
  function Documents() {
    const { session } = React.useSyncExternalStore(
      ctx.relay.subscribe,
      ctx.relay.snapshot,
    );
    const split = ctx.panels.ui.useSplit(
      session.scope,
      "example.documents:reader",
      448,
      320,
    );
    const [names, setNames] = React.useState(["Guide", "Reference"]);
    const [value, select] = React.useState("Guide");
    const items = names.map((name) => ({
      id: name,
      label: "Loading document",
      content: h(Reader, { name, session }),
      close: () => {
        const next = names.filter((item) => item !== name);
        setNames(next);
        if (value === name) select(next[0] ?? "");
      },
    }));
    return h(
      "div",
      {
        ref: split.ref,
        style: split.style,
        className: "document-plugin-workspace",
      },
      h(
        "style",
        null,
        `.document-plugin-workspace { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,var(--secondary-panel-width,448px)); height:100%; min-height:0; } .document-plugin-reader { position:relative; min-width:0; min-height:0; } @media(max-width:650px) { .document-plugin-workspace { grid-template-columns:minmax(0,1fr); } .document-plugin-library { display:none; } .document-plugin-reader > [data-panel-resize] { display:none; } }`,
      ),
      h(
        "div",
        {
          className: "document-plugin-library",
          style: { padding: "var(--space-panel-inset)" },
        },
        "Document collection",
      ),
      h(
        "section",
        {
          className: "document-plugin-reader",
          "aria-label": "Document reader",
        },
        split.handle,
        h(ctx.panels.ui.Workspace, {
          label: "Open documents",
          items,
          value,
          select,
        }),
      ),
    );
  }
  ctx.pages.register({
    id: "documents",
    title: "Documents",
    primary: true,
    layout: "workspace",
    component: Documents,
  });
}
