type Point = { x: number; y: number };
type Hover = {
  row: HTMLElement;
  bar: HTMLElement;
  hit(target: EventTarget | null): boolean;
  retain(target: EventTarget | null, point: Point): boolean;
  changed(hovered: boolean): void;
};

// Travel may cross another message, but resting there must select that message.
export const MESSAGE_ACTION_TRAVEL_IDLE_MS = 150;
const documents = new WeakMap<Document, ReturnType<typeof hoverOwner>>();
const pointers = new WeakMap<
  Document,
  { target: EventTarget | null; point: Point }
>();

export function rememberMessagePointer(event: Event) {
  if (!("clientX" in event) || !(event.target instanceof Node)) return;
  const document = event.target.ownerDocument;
  if (!document) return;
  pointers.set(document, {
    target: event.target,
    point: {
      x: Number(event.clientX),
      y: Number((event as PointerEvent).clientY),
    },
  });
}

/** The convex route from the departure point to every edge of the toolbar. */
export function inToolbarRoute(point: Point, origin: Point, box: DOMRect) {
  const corners = [
    { x: box.left - 2, y: box.top - 2 },
    { x: box.right + 2, y: box.top - 2 },
    { x: box.right + 2, y: box.bottom + 2 },
    { x: box.left - 2, y: box.bottom + 2 },
  ];
  const cross = (a: Point, b: Point, p: Point) =>
    (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
  return corners.some((a, index) => {
    const b = corners[(index + 1) % corners.length];
    if (!b) return false;
    if (Math.abs(cross(origin, a, b)) < 0.001) return false;
    const signs = [
      cross(origin, a, point),
      cross(a, b, point),
      cross(b, origin, point),
    ];
    return signs.every((n) => n >= -0.001) || signs.every((n) => n <= 0.001);
  });
}

const distance = (point: Point, box: DOMRect) =>
  Math.hypot(
    Math.max(box.left - point.x, 0, point.x - box.right),
    Math.max(box.top - point.y, 0, point.y - box.bottom),
  );

function hoverOwner(document: Document) {
  const entries = new Map<Element, Hover>();
  const view = document.defaultView ?? window;
  let current: Hover | undefined;
  let origin: Point | undefined;
  let previous: Point | undefined;
  let closest: Point | undefined;
  let timer: number | undefined;
  const cancel = () => {
    view.clearTimeout(timer);
    timer = undefined;
  };
  const select = (next: Hover | undefined) => {
    cancel();
    if (current === next) return;
    current?.changed(false);
    current = next;
    origin = previous = closest = pointers.get(document)?.point;
    current?.changed(true);
  };
  const candidate = (target: EventTarget | null) => {
    for (
      let node = target instanceof Element ? target : null;
      node;
      node = node.parentElement
    ) {
      const entry = entries.get(node);
      if (entry) return entry.hit(target) ? entry : undefined;
    }
  };
  const update = (event: PointerEvent, immediate = false) => {
    const point = { x: event.clientX, y: event.clientY };
    if (event.pointerType === "touch") {
      const { target } = event;
      if (
        target instanceof Node &&
        (current?.bar.contains(target) ||
          (current?.row.contains(target) && current.retain(target, point)))
      ) {
        cancel();
      } else {
        select(undefined);
      }
      return;
    }
    const target =
      event.type === "pointerout" ? event.relatedTarget : event.target;
    pointers.set(document, { target, point });
    if (current?.hit(target)) {
      cancel();
      origin = previous = closest = point;
      return;
    }
    if (
      (!immediate ||
        (target instanceof Node && current?.row.contains(target))) &&
      current?.retain(target, point)
    ) {
      cancel();
      previous = closest = point;
      return;
    }
    const scope =
      current?.row.closest("[data-message-scroller]") ??
      current?.row.closest("[data-message-id]")?.parentElement ??
      current?.row.parentElement;
    if (
      !immediate &&
      current &&
      origin &&
      previous &&
      closest &&
      target instanceof Element &&
      scope?.contains(target) &&
      current.bar.matches(":popover-open") &&
      current.bar.getBoundingClientRect().width > 0
    ) {
      const box = current.bar.getBoundingClientRect();
      const nextDistance = distance(point, box);
      const closestDistance = distance(closest, box);
      // Apply the tolerance to the closest point so small reversals cannot add up.
      if (
        inToolbarRoute(point, origin, box) &&
        nextDistance <= closestDistance + 0.5
      ) {
        if (nextDistance < closestDistance) closest = point;
        if (
          point.x !== previous.x ||
          point.y !== previous.y ||
          timer === undefined
        ) {
          cancel();
          timer = view.setTimeout(
            () => select(candidate(pointers.get(document)?.target ?? null)),
            MESSAGE_ACTION_TRAVEL_IDLE_MS,
          );
        }
        previous = point;
        return;
      }
    }
    select(candidate(target));
  };
  const move = (event: PointerEvent) => update(event);
  const press = (event: PointerEvent) => update(event, true);
  const clear = () => select(undefined);
  const scroll = ({ target }: Event) => {
    if (
      timer !== undefined &&
      current &&
      target instanceof Node &&
      (target.contains(current.row) || target.contains(current.bar))
    ) {
      clear();
    }
  };
  const events = ["pointerover", "pointerout", "pointermove"] as const;
  for (const type of events) document.addEventListener(type, move, true);
  document.addEventListener("pointerdown", press, true);
  document.addEventListener("pointercancel", clear, true);
  document.addEventListener("scroll", scroll, true);
  view.addEventListener("blur", clear);
  return {
    add(entry: Hover, initiallyHovered: boolean) {
      entries.set(entry.row, entry);
      if (initiallyHovered) {
        if (!current) select(entry);
        else if (current !== entry) entry.changed(false);
      }
      return () => {
        entries.delete(entry.row);
        if (current === entry) clear();
        if (entries.size) return;
        for (const type of events)
          document.removeEventListener(type, move, true);
        document.removeEventListener("pointerdown", press, true);
        document.removeEventListener("pointercancel", clear, true);
        document.removeEventListener("scroll", scroll, true);
        view.removeEventListener("blur", clear);
        documents.delete(document);
        pointers.delete(document);
      };
    },
  };
}

export function observeMessageActionHover(
  entry: Hover,
  initiallyHovered: boolean,
) {
  const document = entry.row.ownerDocument;
  let owner = documents.get(document);
  if (!owner) {
    owner = hoverOwner(document);
    documents.set(document, owner);
  }
  return owner.add(entry, initiallyHovered);
}
