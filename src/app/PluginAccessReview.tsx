import { type Ref, useContext, useSyncExternalStore } from "react";
import { AgentsContext } from "../features/agents/react";
import type { RegisteredAgentType } from "../features/agents/service";

import type { PluginManifest } from "../plugins/api";
import { Accordion } from "../shared/design-system/ui/Accordion";
import { Button } from "../shared/design-system/ui/Button";
import {
  GlobeIcon,
  FolderOpenIcon,
  PlugIcon,
  TerminalWindowIcon,
  MonitorIcon,
} from "../shared/design-system/icons/index";
import styles from "./PluginImport.module.css";

const noSubscribe = () => () => {};
const noTypes = () => EMPTY_TYPES;
const EMPTY_TYPES: readonly RegisteredAgentType[] = [];

function ProgramDetails({
  program,
  args,
}: {
  program: string;
  args: readonly string[];
}) {
  return (
    <>
      <p className="mb-2 mt-1">
        Program: <code className={styles.sourcePath}>{program}</code>
      </p>
      <p className="mb-1 mt-0">Arguments{args.length ? ":" : ": none"}</p>
      {args.length > 0 && (
        <ol className="m-0 list-decimal space-y-2 pl-6">
          {args.map((argument, index) => (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: Argument position is its identity; repeated values are valid.
              key={index}
              aria-label={`Argument ${index + 1}`}
            >
              <pre className="m-0 whitespace-pre-wrap break-words">
                <code className={styles.sourcePath}>{argument}</code>
              </pre>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}

function hostDeclarations(
  manifest: PluginManifest,
  types: readonly RegisteredAgentType[],
) {
  return [
    ...(manifest.host?.agentExecution ?? []).map((harness) => ({
      key: `agentExecution:${harness}`,
      signature: `Agent execution: ${harness}`,
      title: "Agent execution:",
      label: `Run ${types.find((type) => type.key === harness)?.title ?? harness} on another host`,
      hint: "Can run native agent code and read files on that host. Buzz keeps the agent's identity.",
      icon: PlugIcon,
      details: <code className={styles.sourcePath}>{harness}</code>,
    })),
    ...(manifest.host?.agentHooks ?? []).map((harness) => ({
      key: `agentHooks:${harness}`,
      signature: `Agent hooks: ${harness}`,
      title: "Agent hooks:",
      label: `Observe and influence ${types.find((type) => type.key === harness)?.title ?? harness}`,
      hint: "Can read hook events and change or block agent actions.",
      icon: PlugIcon,
      details: <code className={styles.sourcePath}>{harness}</code>,
    })),
    ...(manifest.host?.commands ?? []).map((command) => ({
      key: `command:${command.id}`,
      signature: `Command ${command.id}: ${JSON.stringify([command.program, ...command.args])} · input: ${command.maxInputBytes === undefined ? "none" : `up to ${command.maxInputBytes} bytes`} · output: up to ${command.maxOutputBytes ?? 4096} bytes`,
      title: `Command ${command.id}:`,
      label: `Run ${command.program}`,
      hint: "Run a program on your computer.",
      icon: TerminalWindowIcon,
      details: (
        <>
          <ProgramDetails program={command.program} args={command.args} />
          <p className="mb-0 mt-2">
            Input:{" "}
            {command.maxInputBytes === undefined
              ? "none"
              : `up to ${command.maxInputBytes} bytes`}
          </p>
          <p className="m-0">
            Output: up to {command.maxOutputBytes ?? 4096} bytes
          </p>
        </>
      ),
    })),
    ...(manifest.host?.networkOrigins ?? []).map((origin) => ({
      key: `origin:${origin}`,
      signature: `HTTPS origin: ${origin}`,
      title: "HTTPS origin:",
      name: `HTTPS origin ${origin}`,
      label: `Connect to ${origin}`,
      hint: "Buzz can make HTTPS requests to this address for the plugin.",
      icon: GlobeIcon,
      details: <code className={styles.sourcePath}>{origin}</code>,
    })),
    ...(manifest.host?.publicImages
      ? [
          {
            key: "publicImages",
            signature:
              "Public images: any public HTTPS site · images returned only · no cookies",
            title: "Public images:",
            label: "Contact any public website for images",
            hint: "The plugin picks the address, so it can send what it knows to any site in that address. Only images come back, without your cookies.",
            icon: GlobeIcon,
            details: (
              <p className="m-0">
                Each request goes to port 443 on a public address and follows no
                redirect: the plugin sees where a redirect points and decides
                whether to ask again. Only PNG, JPEG, GIF, WebP and AVIF images
                are returned. The address check can't recognize internal sites
                that resolve to public addresses, such as those reached through
                a company VPN, so the plugin has to refuse those itself. Sites
                see your IP address.
              </p>
            ),
          },
        ]
      : []),
    ...(manifest.host?.publicPages
      ? [
          {
            key: "publicPages",
            signature:
              "Public pages: any public HTTPS site · title, description and image only · no cookies",
            title: "Public pages:",
            label: "Contact any public website for link previews",
            hint: "The plugin picks the address, so it can send what it knows to any site in that address. Only a page's title, description, site name, image and icon come back, without your cookies.",
            icon: GlobeIcon,
            details: (
              <p className="m-0">
                Each request goes to port 443 on a public address and follows no
                redirect: the plugin sees where a redirect points and decides
                whether to ask again. Buzz reads at most the page's head and
                returns only its preview fields, never the page itself. The
                address check can't recognize internal sites that resolve to
                public addresses, such as those reached through a company VPN,
                so the plugin has to refuse those itself. Sites see your IP
                address.
              </p>
            ),
          },
        ]
      : []),
    ...(manifest.host?.federatedIdentity?.operations ?? []).map(
      (operation) => ({
        key: `federated:${operation.method} ${operation.path}`,
        signature: `Federated authority ${manifest.host?.federatedIdentity?.authority}: ${operation.method} ${operation.path}`,
        title: `Federated authority ${manifest.host?.federatedIdentity?.authority}:`,
        label: `${operation.method} ${operation.path}`,
        hint: "Buzz can call this route with your community session for the plugin.",
        icon: GlobeIcon,
        details: <code className={styles.sourcePath}>{operation.path}</code>,
      }),
    ),
    ...(manifest.host?.processes ?? []).map((process) => ({
      key: `process:${process.id}`,
      signature: `Process ${process.id}: ${JSON.stringify([process.program, ...(process.args ?? [])])}${process.bundled ? " (bundled with Buzz)" : ""} · artifact: ${JSON.stringify(process.artifact ?? null)} and any further arguments · stdin, full user access`,
      title: `Process ${process.id}:`,
      label: `Start ${process.program}`,
      hint: "Can start a background process with additional arguments, using your account’s full access.",
      icon: TerminalWindowIcon,
      details: (
        <>
          <ProgramDetails program={process.program} args={process.args ?? []} />
          {process.bundled && <p className="mb-0 mt-2">Bundled with Buzz.</p>}
          {process.artifact && (
            <div className="mt-2 break-all">
              <p className="m-0">
                Executable artifact: <code>{process.artifact.path}</code>
              </p>
              <p className="m-0">
                SHA-256: <code>{process.artifact.sha256}</code>
              </p>
              {process.artifact.siblings?.map((sibling) => (
                <p className="m-0" key={sibling.name}>
                  Sibling <code>{sibling.name}</code>:{" "}
                  <code>{sibling.sha256}</code>
                </p>
              ))}
            </div>
          )}
          <p className="mb-0 mt-2">
            Allows further arguments and standard input, with your account’s
            full access.
          </p>
        </>
      ),
    })),
    ...(manifest.host?.mcp
      ? [
          {
            key: "mcp",
            signature:
              "MCP servers: tools served to local agents over loopback HTTP",
            title: "MCP servers:",
            label: "Provide tools to local agents",
            hint: "Exposes plugin tools through Buzz’s local MCP server.",
            icon: PlugIcon,
            details: (
              <p className="m-0">
                Tools served to local agents over loopback HTTP.
              </p>
            ),
          },
        ]
      : []),
    ...(manifest.host?.managedFiles
      ? [
          {
            key: "managedFiles",
            signature:
              "Managed files: temporary private saves · no file reading",
            title: "Managed files:",
            label: "Save temporary plugin files",
            hint: "Save up to 16 MiB at a time in host-selected private storage, without file-reading access.",
            icon: FolderOpenIcon,
            details: (
              <p className="m-0">
                Shared storage is limited to 64 MiB and 16 files; any plugin can
                fill it. Files normally remain for 24 hours, survive plugin
                unload and app restart, and are removed on a later save after
                expiry. Explicit app-data erase or user deletion can remove them
                sooner. This does not grant file reading or arbitrary-path
                writes.
              </p>
            ),
          },
        ]
      : []),
    ...(manifest.host?.files
      ? [
          {
            key: "files",
            signature:
              "Files: read any file and resolve folders · full user access",
            title: "Files:",
            label: "Read your files",
            hint: "Can read any file your account can, and create folders it resolves.",
            icon: FolderOpenIcon,
            details: (
              <p className="m-0">
                Reads files and resolves folders with your account’s full
                access.
              </p>
            ),
          },
        ]
      : []),
  ];
}

export function pluginAccessIncreases(
  manifest: PluginManifest,
  previous: PluginManifest,
) {
  const granted = new Set(
    hostDeclarations(previous, []).map((item) => item.signature),
  );
  return hostDeclarations(manifest, []).some(
    (item) => !granted.has(item.signature),
  );
}

export function PluginAccessReview({
  manifest,
  previousManifest,
  unchangedOnly = false,
  unchangedTrigger,
  onShowUnchanged,
}: {
  manifest: PluginManifest;
  previousManifest?: PluginManifest | undefined;
  unchangedOnly?: boolean;
  unchangedTrigger?: Ref<HTMLButtonElement>;
  onShowUnchanged?: () => void;
}) {
  const agents = useContext(AgentsContext);
  const types = useSyncExternalStore(
    agents?.subscribe ?? noSubscribe,
    agents?.types ?? noTypes,
    noTypes,
  );
  const updating = !!previousManifest;
  const declaredDetails = hostDeclarations(manifest, types);
  const previousDetails = previousManifest
    ? hostDeclarations(previousManifest, types)
    : [];
  const previousGrants = previousDetails.map((grant) => grant.signature);
  const removedDetails = previousDetails.filter(
    (grant) => !declaredDetails.some((next) => next.key === grant.key),
  );
  const addedDetails = declaredDetails.filter(
    (grant) => !previousDetails.some((previous) => previous.key === grant.key),
  );
  const changedDetails = declaredDetails.filter((grant) =>
    previousDetails.some(
      (previous) =>
        previous.key === grant.key && previous.signature !== grant.signature,
    ),
  );
  const unchangedDetails = declaredDetails.filter((grant) =>
    previousGrants.includes(grant.signature),
  );
  const hasAccessChanges =
    addedDetails.length + changedDetails.length + removedDetails.length > 0;
  function scopeItem(
    grant: ReturnType<typeof hostDeclarations>[number],
    removed = false,
    compare = updating,
  ) {
    const changed =
      compare &&
      !!previousManifest &&
      !removed &&
      !previousGrants.includes(grant.signature);
    const previous = changed
      ? previousDetails.find((item) => item.key === grant.key)
      : undefined;
    const changeLabel = changed ? (previous ? " (changed)" : " (added)") : "";
    const Icon = grant.icon;
    return {
      value: grant.signature,
      title: (
        <span className="flex items-start gap-3 text-left text-body-sm break-words">
          <Icon size={20} aria-hidden="true" className="shrink-0 text-muted" />
          <span className="min-w-0">
            <span className="block font-medium">
              {removed ? "Removed: " : ""}
              {grant.label}
              {changeLabel}
            </span>
            <span className="block text-muted">{grant.hint}</span>
          </span>
        </span>
      ),
      content: (
        <section
          aria-label={`${removed ? "Removed " : ""}${"name" in grant ? grant.name : grant.title.slice(0, -1)} details`}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: Scroll owner supports keyboard access to long command details.
          tabIndex={0}
          className={styles.technicalDetails}
        >
          <p className="m-0 font-medium">
            {grant.title}
            {changeLabel}
          </p>
          {previous && (
            <>
              <p className="mb-2 mt-3 text-label">Previously</p>
              {previous.details}
              <p className="mb-2 mt-3 text-label">After this update</p>
            </>
          )}
          {grant.details}
        </section>
      ),
    };
  }
  const allDeclarations = (
    <section aria-label="Declared scopes">
      {(updating ? unchangedDetails : declaredDetails).length ? (
        <Accordion
          animate
          key={manifest.id}
          items={(updating ? unchangedDetails : declaredDetails).map((grant) =>
            scopeItem(grant, false, false),
          )}
        />
      ) : (
        <p className="m-0">No additional capabilities declared.</p>
      )}
    </section>
  );

  if (unchangedOnly) return allDeclarations;
  return (
    <section aria-label="Computer access" className="text-body-sm">
      {updating && (
        <section aria-label="Declared access changes" className="mb-4">
          <p className="mt-0 mb-2 text-label">
            {hasAccessChanges
              ? "Declared access changes"
              : "No declared access changes"}
          </p>
          {(
            [
              ["Added", addedDetails],
              ["Changed", changedDetails],
              ["Removed", removedDetails],
            ] as const
          ).map(
            ([label, grants]) =>
              grants.length > 0 && (
                <section
                  key={label}
                  aria-label={`${label} declarations`}
                  className="mt-3"
                >
                  <p className="mt-0 mb-2 text-label">{label}</p>
                  <Accordion
                    animate
                    key={`${manifest.id}-${label}`}
                    items={grants.map((grant) =>
                      scopeItem(grant, label === "Removed"),
                    )}
                  />
                </section>
              ),
          )}
        </section>
      )}
      {updating ? (
        <p className="mt-0 mb-4 text-body-sm text-muted" role="note">
          Plugins can access your computer beyond these declarations. Only
          update code you trust.
        </p>
      ) : (
        <Accordion
          animate
          key={`computer-${manifest.id}`}
          items={[
            {
              value: "computer-access",
              title: (
                <span className="flex items-start gap-3 text-left text-body-sm">
                  <MonitorIcon
                    size={20}
                    className="shrink-0 text-muted"
                    aria-hidden="true"
                  />
                  <span>
                    <span className="block font-medium">Computer access</span>
                    <span className="block text-muted">
                      Can access files and run programs on your computer.
                    </span>
                  </span>
                </span>
              ),
              content: (
                <section
                  aria-label="Plugin safety"
                  className="max-w-prose pl-8 text-body"
                >
                  <h4 className="mb-2 mt-0 text-label">
                    Access beyond this list
                  </h4>
                  <p className="m-0">
                    Plugins aren’t sandboxed. They can access your computer
                    beyond these declarations, even when no additional
                    capabilities are listed.
                  </p>
                  <p className="mb-0 mt-3 text-muted">
                    These declarations describe what the plugin asks Buzz to do.
                    They don’t limit what its code can do.
                  </p>
                </section>
              ),
            },
          ]}
        />
      )}
      {updating
        ? unchangedDetails.length > 0 && (
            <Button
              ref={unchangedTrigger}
              variant="link"
              size="inline"
              onClick={onShowUnchanged}
            >
              View unchanged declarations
            </Button>
          )
        : allDeclarations}
    </section>
  );
}
