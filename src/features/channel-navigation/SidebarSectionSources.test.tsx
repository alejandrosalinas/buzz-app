// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createContext, useContext, useLayoutEffect, useState } from "react";
import {
  SidebarSectionSources,
  SidebarSectionSlotView,
} from "./SidebarSectionSources";
import {
  sidebarSectionSlots,
  orderSidebarSectionSlots,
  type RegisteredSidebarSectionSource,
  type SidebarSectionEnvironment,
} from "./sidebar-section-components";
import type { SidebarSections } from "./sidebar-sections-service";
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const environment = {} as SidebarSectionEnvironment;
const owner = (
  id: string,
  component: RegisteredSidebarSectionSource["component"],
): RegisteredSidebarSectionSource => ({
  version: 2,
  id,
  key: `example.plugin/${id}`,
  pluginId: "example.plugin",
  revision: "bundled",
  scope: "team",
  context: "example.plugin/navigation",
  component,
});
function registry(
  sources: readonly RegisteredSidebarSectionSource[],
): SidebarSections {
  return {
    version: 1,
    register: () => {},
    snapshot: () => [],
    subscribe: () => () => {},
    sourceSnapshot: () => sources,
    sourceSubscribe: () => () => {},
  };
}
function renderSources(sources: readonly RegisteredSidebarSectionSource[]) {
  return render(
    <SidebarSectionSources
      registry={registry(sources)}
      environment={environment}
    >
      {(slots, sources) => (
        <>
          {sources()}
          {slots.map((slot) => (
            <SidebarSectionSlotView key={slot.key} slot={slot} />
          ))}
          <p>v1 sibling</p>
        </>
      )}
    </SidebarSectionSources>,
  );
}
it.each([false, true])(
  "settles a source without sections (explicit render: %s) while healthy slots and v1 survive",
  (explicit) => {
    const ready = vi.fn();
    const sources = [
      owner("empty", ({ render }) => (explicit ? render([]) : null)),
      owner("solo", ({ render }) =>
        render([
          { id: "solo", defaultPosition: 0, element: <p>Solo survives</p> },
        ]),
      ),
    ];
    render(
      <SidebarSectionSources
        registry={registry(sources)}
        environment={environment}
        onReady={ready}
      >
        {(slots, nodes) => (
          <>
            {nodes()}
            {slots.map((slot) => (
              <SidebarSectionSlotView key={slot.key} slot={slot} />
            ))}
            <p>v1 survives</p>
          </>
        )}
      </SidebarSectionSources>,
    );
    expect(screen.getByText("Solo survives")).toBeInTheDocument();
    expect(screen.getByText("v1 survives")).toBeInTheDocument();
    expect(ready).toHaveBeenLastCalledWith(
      true,
      expect.any(Array),
      expect.any(Array),
    );
  },
);

it("settles after a live source stops publishing and later resumes", () => {
  let toggle!: (shown: boolean) => void;
  const source = owner("empty", ({ render }) => {
    const [shown, setShown] = useState(true);
    toggle = setShown;
    return shown
      ? render([
          { id: "row", defaultPosition: 0, element: <p>Optional row</p> },
        ])
      : null;
  });
  const ready = vi.fn();
  render(
    <SidebarSectionSources
      registry={registry([source])}
      environment={environment}
      onReady={ready}
    >
      {(slots, nodes) => (
        <>
          {nodes()}
          {slots.map((slot) => (
            <SidebarSectionSlotView key={slot.key} slot={slot} />
          ))}
        </>
      )}
    </SidebarSectionSources>,
  );
  act(() => toggle(false));
  expect(screen.queryByText("Optional row")).toBeNull();
  expect(ready).toHaveBeenLastCalledWith(
    true,
    expect.any(Array),
    expect.any(Array),
  );
  act(() => toggle(true));
  expect(screen.getByText("Optional row")).toBeInTheDocument();
  expect(ready).toHaveBeenLastCalledWith(
    true,
    expect.any(Array),
    expect.any(Array),
  );
});

it("settles when another source emits an already-owned slot key", () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const sources = ["first", "second"].map((id) =>
    owner(id, ({ render }) =>
      render([{ id: "same", defaultPosition: 0, element: <p>{id} row</p> }]),
    ),
  );
  const ready = vi.fn();
  render(
    <SidebarSectionSources
      registry={registry(sources)}
      environment={environment}
      onReady={ready}
    >
      {(slots, nodes) => (
        <>
          {nodes()}
          {slots.map((slot) => (
            <SidebarSectionSlotView key={slot.key} slot={slot} />
          ))}
        </>
      )}
    </SidebarSectionSources>,
  );
  expect(screen.getByText("first row")).toBeInTheDocument();
  expect(screen.queryByText("second row")).toBeNull();
  expect(ready).toHaveBeenLastCalledWith(
    true,
    expect.any(Array),
    expect.any(Array),
  );
});
it("keeps preference order and valid opaque group ids, skipping only invalid or duplicate slots", () => {
  const source = owner("team", () => null);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const ids = ["group:z", "group:ABC", "group:with space/slash", "channels"];
  const slots = sidebarSectionSlots(
    source,
    ids.map((id, i) => ({ id, defaultPosition: i, element: <p>{id}</p> })),
  );
  expect(
    orderSidebarSectionSlots([...slots, ...slots.slice(0, 1)]).map(
      (slot) => slot.key,
    ),
  ).toEqual(ids.map((id) => `example.plugin/${id}`));
  expect(
    sidebarSectionSlots(source, [
      { id: "", defaultPosition: 0, element: <p /> },
      { id: "valid", defaultPosition: 1, element: <p /> },
    ]),
  ).toHaveLength(1);
  expect(warn).toHaveBeenCalledTimes(1);
});
it("contains a failed source and a failed leaf while keeping healthy sources and v1 usable", () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  function Broken(): never {
    throw new Error("broken leaf");
  }
  renderSources([
    owner("failed-source", () => {
      throw new Error("broken source");
    }),
    owner("team", ({ render }) =>
      render([
        { id: "broken", defaultPosition: 0, element: <Broken /> },
        {
          id: "healthy",
          defaultPosition: 1,
          element: <button type="button">Healthy</button>,
        },
      ]),
    ),
  ]);
  expect(screen.getAllByRole("alert")).toHaveLength(2);
  expect(screen.getByRole("button", { name: "Healthy" })).toBeInTheDocument();
  expect(screen.getByText("v1 sibling")).toBeInTheDocument();
});
it("preserves leaf state and focus when a live source emits fresh descriptors", () => {
  let refresh!: () => void;
  function Stateful() {
    const [count, setCount] = useState(0);
    return (
      <button type="button" onClick={() => setCount(count + 1)}>
        Count {count}
      </button>
    );
  }
  const source = owner("live", ({ render }) => {
    const [, update] = useState(0);
    refresh = () => update((n) => n + 1);
    return render([
      { id: "stable", defaultPosition: 0, element: <Stateful /> },
    ]);
  });
  renderSources([source]);
  const row = screen.getByRole("button", { name: "Count 0" });
  row.focus();
  fireEvent.click(row);
  fireEvent.click(row);
  act(() => refresh());
  expect(screen.getByRole("button", { name: "Count 2" })).toBe(row);
  expect(row).toHaveFocus();
});

function StatefulRow({ label }: { label: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(!open)}>
        {label}
      </button>
      {open && <p>{label} menu</p>}
    </>
  );
}

it("keeps the host and healthy slots mounted through late activation, source failure, retry and replacement", () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const listeners = new Set<() => void>();
  let sources: readonly RegisteredSidebarSectionSource[] = [];
  const service = {
    ...registry(sources),
    sourceSnapshot: () => sources,
    sourceSubscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const update = (next: readonly RegisteredSidebarSectionSource[]) =>
    act(() => {
      sources = next;
      for (const listener of listeners) listener();
    });
  let fail!: (value: boolean) => void;
  let originalActive!: () => boolean;
  const flaky = owner("flaky", ({ render, active }) => {
    const [failed, setFailed] = useState(false);
    fail = setFailed;
    originalActive = active;
    if (failed) throw new Error("source failed after mounting");
    return render([
      { id: "flaky", defaultPosition: 0, element: <p>Original source</p> },
    ]);
  });
  const healthy = owner("healthy", ({ render }) =>
    render([
      {
        id: "healthy",
        defaultPosition: 1,
        element: <StatefulRow label="Healthy row" />,
      },
    ]),
  );
  const ready = vi.fn();
  render(
    <SidebarSectionSources
      registry={service}
      environment={environment}
      onReady={ready}
    >
      {(slots, sources) => (
        <>
          {sources()}
          <StatefulRow label="Host row" />
          {slots.map((slot) => (
            <SidebarSectionSlotView key={slot.key} slot={slot} />
          ))}
        </>
      )}
    </SidebarSectionSources>,
  );
  const host = screen.getByRole("button", { name: "Host row" });
  fireEvent.click(host);
  host.focus();
  expect(ready).toHaveBeenLastCalledWith(
    false,
    expect.any(Array),
    expect.any(Array),
  );
  update([flaky, healthy]);
  expect(screen.getByRole("button", { name: "Host row" })).toBe(host);
  expect(host).toHaveFocus();
  expect(screen.getByText("Host row menu")).toBeInTheDocument();
  expect(ready).toHaveBeenLastCalledWith(
    true,
    expect.any(Array),
    expect.any(Array),
  );
  const row = screen.getByRole("button", { name: "Healthy row" });
  fireEvent.click(row);
  row.focus();
  const stale = originalActive;
  act(() => fail(true));
  expect(stale()).toBe(false);
  expect(screen.getByRole("alert")).toHaveTextContent(
    "This optional control is unavailable",
  );
  expect(screen.getByRole("button", { name: "Healthy row" })).toBe(row);
  expect(row).toHaveFocus();
  expect(screen.getByText("Healthy row menu")).toBeInTheDocument();
  expect(screen.getByText("Host row menu")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(screen.getByText("Original source")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Healthy row" })).toBe(row);
  const replacement = owner("flaky", ({ render }) =>
    render([
      { id: "flaky", defaultPosition: 0, element: <p>Replacement source</p> },
    ]),
  );
  update([healthy]);
  update([replacement, healthy]);
  expect(screen.queryByText("Original source")).toBeNull();
  expect(screen.getAllByText("Replacement source")).toHaveLength(1);
  expect(screen.getByRole("button", { name: "Healthy row" })).toBe(row);
  expect(screen.getByText("Healthy row menu")).toBeInTheDocument();
});

it("contains a leaf that fails after mounting and retries it without resetting healthy state", () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  let fail!: (value: boolean) => void;
  let broken = false;
  function Leaf() {
    const [failed, setFailed] = useState(false);
    fail = setFailed;
    if (failed && broken) throw new Error("leaf failed after mounting");
    return <p>Recovered leaf</p>;
  }
  renderSources([
    owner("team", ({ render }) =>
      render([
        { id: "leaf", defaultPosition: 0, element: <Leaf /> },
        {
          id: "healthy",
          defaultPosition: 1,
          element: <StatefulRow label="Sibling" />,
        },
      ]),
    ),
  ]);
  const row = screen.getByRole("button", { name: "Sibling" });
  fireEvent.click(row);
  row.focus();
  broken = true;
  act(() => fail(true));
  expect(screen.getByRole("alert")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Sibling" })).toBe(row);
  expect(row).toHaveFocus();
  expect(screen.getByText("Sibling menu")).toBeInTheDocument();
  broken = false;
  fireEvent.click(screen.getByRole("button", { name: "Retry sidebar" }));
  expect(screen.getByText("Recovered leaf")).toBeInTheDocument();
  expect(screen.getByText("Sibling menu")).toBeInTheDocument();
});

it("commits a changed environment once with fresh props even when surrounding navigation context changes", () => {
  const NavigationTarget = createContext("A");
  const effects: string[] = [];
  const renders = vi.fn();
  function Probe({ label }: { label: string }) {
    const current = useContext(NavigationTarget);
    renders();
    useLayoutEffect(() => {
      effects.push(`${label}:${current}`);
    });
    return <p>{label}</p>;
  }
  const source = owner("solo", ({ target, render }) =>
    render([
      {
        id: "probe",
        defaultPosition: 0,
        element: <Probe label={String(target.kind)} />,
      },
    ]),
  );
  const service = registry([source]);
  const tree = (target: string) => (
    <NavigationTarget value={target}>
      <SidebarSectionSources
        registry={service}
        environment={{ ...environment, target: { kind: target } as never }}
      >
        {(slots, sources) => (
          <>
            {sources()}
            {slots.map((slot) => (
              <SidebarSectionSlotView key={slot.key} slot={slot} />
            ))}
          </>
        )}
      </SidebarSectionSources>
    </NavigationTarget>
  );
  const view = render(tree("A"));
  effects.length = 0;
  renders.mockClear();
  view.rerender(tree("B"));
  expect(effects).toEqual(["B:B"]);
  expect(renders).toHaveBeenCalledTimes(1);
});

it("moves the same portal containers when live group order changes", () => {
  let reorder!: () => void;
  const source = owner("groups", ({ render }) => {
    const [ids, setIds] = useState(["z", "a"]);
    reorder = () => setIds(["a", "z"]);
    return render(
      ids.map((id, index) => ({
        id: `group:${id}`,
        defaultPosition: index,
        element: <StatefulRow label={`Group ${id}`} />,
      })),
    );
  });
  renderSources([source]);
  const row = screen.getByRole("button", { name: "Group z" });
  const container = row.closest("[data-sidebar-slot]");
  fireEvent.click(row);
  row.focus();
  act(() => reorder());
  expect(
    [...document.querySelectorAll("[data-sidebar-slot]")].map((el) =>
      el.getAttribute("data-sidebar-slot"),
    ),
  ).toEqual(["example.plugin/group:a", "example.plugin/group:z"]);
  expect(screen.getByRole("button", { name: "Group z" })).toBe(row);
  expect(row.closest("[data-sidebar-slot]")).toBe(container);
  expect(row).toHaveFocus();
  expect(screen.getByText("Group z menu")).toBeInTheDocument();
});
