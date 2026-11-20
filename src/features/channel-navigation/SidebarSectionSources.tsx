import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { OwnedContribution } from "../../plugins/OwnedContribution";
import {
  ContributionBoundary,
  contributionKey,
} from "../conversation/ContributionBoundary";
import { Button } from "../../shared/design-system/ui/Button";
import type { SidebarSections } from "./sidebar-sections-service";
import {
  sidebarSectionSlots,
  orderSidebarSectionSlots,
  type SidebarComponentSection,
  type SidebarSectionEnvironment,
  type SidebarSectionSlot,
  type RegisteredSidebarSectionSource,
} from "./sidebar-section-components";

const empty: readonly RegisteredSidebarSectionSource[] = [];
const snapshot = () => empty;
const subscribe = () => () => {};
const targetKey = (source: object, key: string) =>
  `${contributionKey(source)}:${key}`;

/** Only structure crosses to the host. Content stays in its source's current React render. */
function createSlotStore() {
  let values: ReadonlyMap<
    number,
    { slots: readonly SidebarSectionSlot[]; committed: readonly string[] }
  > = new Map();
  let targets: ReadonlyMap<string, HTMLElement> = new Map();
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  return {
    snapshot: () => values,
    targets: () => targets,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    mount(key: string, node: HTMLElement | null) {
      if (targets.get(key) === (node ?? undefined)) return;
      const next = new Map(targets);
      if (node) next.set(key, node);
      else next.delete(key);
      targets = next;
      notify();
    },
    publish(
      owner: number,
      slots?: readonly SidebarSectionSlot[],
      committed: readonly string[] = [],
    ) {
      const old = values.get(owner);
      if (
        slots &&
        old &&
        old.committed.length === committed.length &&
        old.committed.every((key, i) => key === committed[i]) &&
        old.slots.length === slots.length &&
        old.slots.every(
          (slot, i) =>
            slot.key === slots[i]?.key &&
            slot.defaultPosition === slots[i]?.defaultPosition &&
            slot.unavailable === slots[i]?.unavailable,
        )
      )
        return;
      const next = new Map(values);
      if (slots) next.set(owner, { slots, committed });
      else if (!next.delete(owner)) return;
      values = next;
      notify();
    },
  };
}
type SlotStore = ReturnType<typeof createSlotStore>;
const Slots = createContext<SlotStore | undefined>(undefined);

/** Place sources beside the slots, under the host's drag and event owners. */
export function SidebarSectionSources({
  registry,
  environment,
  children,
  onReady,
  settled = false,
}: {
  settled?: boolean;
  registry: SidebarSections | undefined;
  environment: SidebarSectionEnvironment;
  children(
    slots: readonly SidebarSectionSlot[],
    sources: (
      scope?: string,
      include?: (source: RegisteredSidebarSectionSource) => boolean,
    ) => ReactNode,
  ): ReactNode;
  onReady?:
    | ((
        ready: boolean,
        keys: readonly string[],
        unavailable: readonly string[],
      ) => void)
    | undefined;
}) {
  const sources = useSyncExternalStore(
    registry?.sourceSubscribe ?? subscribe,
    registry?.sourceSnapshot ?? snapshot,
    registry?.sourceSnapshot ?? snapshot,
  );
  const [store] = useState(createSlotStore);
  const components = (
    scope?: string,
    include?: (source: RegisteredSidebarSectionSource) => boolean,
  ) =>
    registry &&
    sources
      .filter(
        (source) =>
          (!scope || source.scope === scope) && (!include || include(source)),
      )
      .map((source) => (
        <SectionSource
          key={contributionKey(source)}
          source={source}
          registry={registry}
          environment={environment}
          store={store}
        />
      ));
  return (
    <Slots value={store}>
      <SlotList
        sources={sources}
        store={store}
        onReady={onReady}
        settled={settled}
      >
        {(slots) => children(slots, components)}
      </SlotList>
    </Slots>
  );
}

function SectionSource({
  source,
  registry,
  environment,
  store,
}: {
  source: RegisteredSidebarSectionSource;
  registry: SidebarSections;
  environment: SidebarSectionEnvironment;
  store: SlotStore;
}) {
  const [attempt, setAttempt] = useState(0);
  const owner = contributionKey(source);
  useSyncExternalStore(
    store.subscribe,
    () => store.snapshot().has(owner),
    () => store.snapshot().has(owner),
  );
  // Child publications commit first. A source returning null must settle too,
  // including when its own local update unmounts a previous publication.
  useLayoutEffect(() => {
    if (!store.snapshot().has(owner)) store.publish(owner, []);
  });
  useLayoutEffect(() => () => store.publish(owner), [owner, store]);
  const owned = useMemo(
    () => ({ snapshot: registry.sourceSnapshot ?? snapshot }),
    [registry.sourceSnapshot],
  );
  const Component = source.component;
  return (
    <OwnedContribution
      entry={source}
      registry={owned}
      resetIdentity={attempt}
      fallback={
        <Publication
          source={source}
          store={store}
          unavailable
          sections={[
            {
              id: `${source.id}:unavailable`,
              defaultPosition: 0,
              element: (
                <SectionUnavailable retry={() => setAttempt((n) => n + 1)} />
              ),
            },
          ]}
        />
      }
    >
      {(_, active) => (
        <Component
          {...environment}
          active={active}
          render={(sections) => (
            <Publication source={source} store={store} sections={sections} />
          )}
        />
      )}
    </OwnedContribution>
  );
}

function Publication({
  source,
  store,
  sections,
  unavailable = false,
}: {
  source: RegisteredSidebarSectionSource;
  store: SlotStore;
  sections: readonly SidebarComponentSection[];
  unavailable?: boolean;
}) {
  const owner = contributionKey(source);
  const targets = useSyncExternalStore(
    store.subscribe,
    store.targets,
    store.targets,
  );
  const slots = sidebarSectionSlots(source, sections).map((slot) => ({
    ...slot,
    unavailable,
  }));
  const committed = slots
    .filter((slot) => targets.has(targetKey(source, slot.key)))
    .map((slot) => slot.key);
  useLayoutEffect(() => {
    store.publish(
      owner,
      slots.map(({ element: _, ...slot }) => slot),
      committed,
    );
  });
  useLayoutEffect(() => () => store.publish(owner), [owner, store]);
  return slots.map((slot) => {
    const container = targets.get(targetKey(source, slot.key));
    return container
      ? createPortal(
          <SlotContents element={slot.element} title={slot.title} />,
          container,
          slot.key,
        )
      : null;
  });
}

function SlotList({
  sources,
  store,
  children,
  onReady,
  settled,
}: {
  sources: readonly RegisteredSidebarSectionSource[];
  store: SlotStore;
  settled: boolean;
  children(slots: readonly SidebarSectionSlot[]): ReactNode;
  onReady?:
    | ((
        ready: boolean,
        keys: readonly string[],
        unavailable: readonly string[],
      ) => void)
    | undefined;
}) {
  const values = useSyncExternalStore(
    store.subscribe,
    store.snapshot,
    store.snapshot,
  );
  const slots = orderSidebarSectionSlots(
    sources.flatMap(
      (source) => values.get(contributionKey(source))?.slots ?? [],
    ),
  );
  const ready =
    sources.length === 0
      ? settled
      : sources.every((source) => values.has(contributionKey(source))) &&
        slots.every((slot) =>
          values
            .get(contributionKey(slot.source))
            ?.committed.includes(slot.key),
        );
  const committedKeys = JSON.stringify(
    ready ? slots.map((slot) => slot.key) : [],
  );
  const unavailableKeys = JSON.stringify(
    slots.filter((slot) => slot.unavailable).map((slot) => slot.source.key),
  );
  useLayoutEffect(() => {
    onReady?.(ready, JSON.parse(committedKeys), JSON.parse(unavailableKeys));
  }, [onReady, ready, committedKeys, unavailableKeys]);
  useLayoutEffect(() => () => onReady?.(false, [], []), [onReady]);
  return children(slots);
}

function SectionUnavailable({
  retry,
  inventory = false,
  title,
}: {
  retry(): void;
  inventory?: boolean;
  title?: string | undefined;
}) {
  return (
    <>
      <p role="alert">
        {inventory
          ? "Conversations couldn’t open."
          : "This optional control is unavailable. Other settings and channel recovery remain available."}
      </p>
      <Button
        size="sm"
        aria-label={title ? `Retry ${title}` : undefined}
        onClick={retry}
      >
        {inventory && !title ? "Retry sidebar" : "Retry"}
      </Button>
    </>
  );
}

function SlotContents({
  element,
  title,
}: {
  element: ReactNode;
  title?: string | undefined;
}) {
  const [attempt, setAttempt] = useState(0);
  return (
    <ContributionBoundary
      resetIdentity={attempt}
      fallback={
        <SectionUnavailable
          inventory
          title={title}
          retry={() => setAttempt((n) => n + 1)}
        />
      }
    >
      {element}
    </ContributionBoundary>
  );
}

/** Key this by slot.key: reordering moves the same portal container and its focused content. */
export function SidebarSectionSlotView({ slot }: { slot: SidebarSectionSlot }) {
  const store = useContext(Slots);
  if (!store) throw new Error("Sidebar slots require SidebarSectionSources");
  const key = targetKey(slot.source, slot.key);
  const mount = useCallback(
    (node: HTMLDivElement | null) => store.mount(key, node),
    [key, store],
  );
  return (
    <div
      ref={mount}
      data-sidebar-slot={slot.key}
      style={{ display: "contents" }}
    />
  );
}
