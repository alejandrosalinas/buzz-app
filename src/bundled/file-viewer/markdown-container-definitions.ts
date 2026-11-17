// A current container block is a temporary lexical view, never a retained AST.
import { fenceLine } from "./markdown-fences";
import type { FenceState, Owner } from "./markdown-fences";
import { referenceDefinitions } from "./markdown-references";
import type {
  DefinitionBudget,
  ReferenceDefinition,
  ReferenceWindow,
} from "./markdown-references";
import { MAX_RENDER_CHARS, required } from "./markdown-limits";

export type ContainedDefinition = ReferenceDefinition & {
  owners?: readonly Owner[] | undefined;
  bodyStart?: number | undefined;
  padding?: number | undefined;
};
export type DefinitionReader = ReturnType<typeof referenceDefinitions> & {
  contained?(
    offset: number,
    bodyStart: number,
    state: FenceState,
    padding?: number,
  ): ContainedDefinition | undefined;
};

// The initial size controls copying, not accepted syntax: undecided input grows
// to the existing rendering budget and reports exhaustion instead of truncation.
const PROJECTION_WINDOW = 4096;

export function containerDefinitions(
  text: string,
  budget: DefinitionBudget,
): DefinitionReader {
  const read: DefinitionReader = referenceDefinitions(text, budget);
  let charged = false,
    admitted = false;
  const retryBudget: DefinitionBudget = {
    get exhausted() {
      return budget.exhausted;
    },
    charge(size) {
      if (!charged) {
        charged = true;
        admitted = budget.charge(size);
      }
      return admitted;
    },
  };
  const project = (
    offset: number,
    bodyStart: number,
    owners: readonly Owner[],
    state: FenceState,
    padding: number,
    capacity: number,
  ) => {
    let physicalEnd = Math.min(text.length, offset + capacity);
    if (text[physicalEnd - 1] === "\r" && text[physicalEnd] === "\n")
      physicalEnd--;
    const physical = text.slice(offset, physicalEnd);
    const rows: {
      physical: number;
      body: number;
      padding: number;
      virtual: number;
      next: number;
    }[] = [];
    const chunks: string[] = [];
    const endings = /\r\n|\r|\n/g;
    const window: ReferenceWindow = {
      complete: physicalEnd === text.length,
      needsMore: false,
    };
    let at = offset,
      virtual = 0,
      current = state;
    while (at < physicalEnd && virtual < capacity) {
      endings.lastIndex = at - offset;
      const ending = endings.exec(physical),
        end = ending ? offset + ending.index : physicalEnd,
        next = ending ? offset + endings.lastIndex : physicalEnd;
      const raw = physical.slice(at - offset, end - offset);
      const step =
        at === offset
          ? undefined
          : fenceLine(raw, { ...current, paragraph: false }, true);
      const syntax =
        at === offset
          ? undefined
          : fenceLine(raw, { ...current, paragraph: true }, false);
      if (
        [step, syntax].some(
          (line) =>
            line &&
            (line.after.owners.length !== owners.length ||
              line.after.owners.some(
                (owner, index) => owner.id !== owners[index]?.id,
              )),
        )
      ) {
        window.complete = !!ending || physicalEnd === text.length;
        break;
      }
      const body = at === offset ? bodyStart : at + required(step).bodyOffset;
      const bodyPadding = at === offset ? padding : required(step).bodyPadding;
      const room = capacity - virtual;
      const to = Math.min(next, body + Math.max(0, room - bodyPadding));
      if (body > to || room < bodyPadding) {
        window.complete = false;
        break;
      }
      const content = " ".repeat(bodyPadding) + text.slice(body, to);
      rows.push({
        physical: at,
        body,
        padding: bodyPadding,
        virtual,
        next: to,
      });
      chunks.push(content);
      virtual += content.length;
      if (to < next) {
        at = to;
        window.complete = false;
        break;
      }
      at = next;
      if (syntax) current = syntax.after;
      if (ending && /^[\t ]*$/.test(text.slice(body, end))) {
        window.complete = true;
        break;
      }
    }
    const source = chunks.join("");
    const definitions = referenceDefinitions(
      source,
      retryBudget,
      undefined,
      window,
    );
    const byPhysical = new Map(rows.map((row) => [row.physical, row]));
    return {
      start: offset,
      end: at,
      capacity,
      owners,
      bodyStart,
      state,
      padding,
      window,
      read(physicalOffset: number): ContainedDefinition | undefined {
        const row = byPhysical.get(physicalOffset);
        if (!row) {
          window.needsMore = !window.complete;
          return undefined;
        }
        const definition = definitions(row.virtual);
        if (!definition) return undefined;
        let low = 0,
          high = rows.length;
        while (low + 1 < high) {
          const middle = (low + high) >>> 1;
          if (required(rows[middle]).virtual < definition.end) low = middle;
          else high = middle;
        }
        const last = required(rows[low]);
        return {
          label: definition.label,
          start: physicalOffset,
          end: Math.min(
            last.next,
            last.body + definition.end - last.virtual - last.padding,
          ),
          owners,
          bodyStart: row.body,
          padding: row.padding,
        };
      },
    };
  };
  let cached: ReturnType<typeof project> | undefined;
  read.contained = (offset, bodyStart, state, padding = 0) => {
    if (
      budget.exhausted ||
      !state.owners.length ||
      !/^ {0,3}\[/.test(
        " ".repeat(padding) + text.slice(bodyStart, bodyStart + 5),
      )
    )
      return undefined;
    charged = false;
    admitted = false;
    if (
      !cached ||
      offset < cached.start ||
      offset >= cached.end ||
      cached.owners.length !== state.owners.length ||
      cached.owners.some((owner, at) => owner.id !== state.owners[at]?.id)
    )
      cached = project(
        offset,
        bodyStart,
        state.owners,
        state,
        padding,
        PROJECTION_WINDOW,
      );
    for (;;) {
      const definition = cached.read(offset);
      if (!cached.window.needsMore) return definition;
      if (budget.exhausted) return undefined;
      if (cached.start !== offset) {
        cached = project(
          offset,
          bodyStart,
          state.owners,
          state,
          padding,
          PROJECTION_WINDOW,
        );
      } else if (cached.capacity < MAX_RENDER_CHARS) {
        cached = project(
          offset,
          bodyStart,
          state.owners,
          state,
          padding,
          Math.min(MAX_RENDER_CHARS, cached.capacity * 2),
        );
      } else {
        // The actual candidate exceeds admitted context. Use the existing
        // explicit too-large fallback; never accept the window's synthetic EOF.
        budget.charge(MAX_RENDER_CHARS + 1);
        return undefined;
      }
    }
  };
  return read;
}

/** Remove only the definition's owning containers, preserving note indentation. */
export function definitionSource(
  text: string,
  span: {
    start: number;
    end: number;
    owners?: readonly Owner[] | undefined;
    bodyStart?: number | undefined;
    padding?: number | undefined;
  },
): string {
  if (!span.owners?.length) return text.slice(span.start, span.end);
  const chunks: string[] = [];
  const endings = /\r\n|\r|\n/g;
  let at = span.start,
    state: FenceState = { owners: span.owners };
  while (at < span.end) {
    endings.lastIndex = at;
    const ending = endings.exec(text),
      end = Math.min(ending?.index ?? span.end, span.end),
      next = Math.min(ending ? endings.lastIndex : span.end, span.end);
    const raw = text.slice(at, end),
      step = fenceLine(raw, state, true);
    const body =
      at === span.start ? (span.bodyStart ?? at) : at + step.bodyOffset;
    const padding = at === span.start ? (span.padding ?? 0) : step.bodyPadding;
    chunks.push(" ".repeat(padding), text.slice(body, next));
    if (at !== span.start) state = step.after;
    at = next;
  }
  return chunks.join("");
}
