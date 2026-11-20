// The reference model of native gateway admission for one membership route
// in one native scope (the owning page/plugin). Native owns the real table,
// handles and authorization; this pure reducer pins down the state machine
// both sides test against, through ADMISSION_VECTORS.
//
// The page pushes (revision, admits) whenever `routeFor` changes. Revisions
// only rise, and a probe's result always arrives under a fresh revision, so
// native applies a push only when its revision is higher than the stored
// one, and reordered pushes can't regress it. A higher revision terminally
// revokes every generation opened under an older one: it is dropped, and
// since native mints every handle once (256-bit random, never reissued),
// nothing reopens it; no tombstones are kept. A generation opens only
// at the current revision while it admits, which the page learns from the
// open's acknowledgement. Dropping the scope (a page reload) drops all of
// its generations; the new scope starts over.

export type Admission = Readonly<{
  revision: number;
  admits: boolean;
  /** Open generations by handle, with the revision each opened under. */
  generations: Readonly<Record<string, number>>;
}>;

export type AdmissionInput =
  | Readonly<{ type: "push"; revision: number; admits: boolean }>
  | Readonly<{ type: "open"; handle: string; revision: number }>
  | Readonly<{ type: "request"; handle: string }>
  | Readonly<{ type: "close_scope" }>;

export type AdmissionOutput =
  | Readonly<{ type: "applied"; revoked: readonly string[] }>
  | Readonly<{ type: "stale" }>
  | Readonly<{ type: "opened"; current: number }>
  | Readonly<{ type: "refused"; current: number; admits: boolean }>
  | Readonly<{ type: "admitted"; revision: number }>
  | Readonly<{ type: "rejected" }>
  | Readonly<{ type: "closed"; revoked: readonly string[] }>;

export const INITIAL_ADMISSION: Admission = Object.freeze({
  revision: 0,
  admits: false,
  generations: Object.freeze({}),
});

export function admit(
  state: Admission,
  input: AdmissionInput,
): Readonly<{ state: Admission; output: AdmissionOutput }> {
  const handles = Object.keys(state.generations).sort();
  switch (input.type) {
    case "push": {
      if (input.revision <= state.revision)
        return { state, output: { type: "stale" } };
      const revoked = handles.filter(
        (handle) => (state.generations[handle] ?? 0) < input.revision,
      );
      const generations = { ...state.generations };
      for (const handle of revoked) delete generations[handle];
      return {
        state: freeze(input.revision, input.admits, generations),
        output: { type: "applied", revoked },
      };
    }
    case "open": {
      if (
        !state.admits ||
        input.revision !== state.revision ||
        input.handle in state.generations
      )
        return {
          state,
          output: {
            type: "refused",
            current: state.revision,
            admits: state.admits,
          },
        };
      return {
        state: freeze(state.revision, state.admits, {
          ...state.generations,
          [input.handle]: state.revision,
        }),
        output: { type: "opened", current: state.revision },
      };
    }
    case "request": {
      const opened = state.generations[input.handle];
      return {
        state,
        output:
          state.admits && opened === state.revision
            ? { type: "admitted", revision: opened }
            : { type: "rejected" },
      };
    }
    case "close_scope":
      return {
        state: INITIAL_ADMISSION,
        output: { type: "closed", revoked: handles },
      };
  }
}

const freeze = (
  revision: number,
  admits: boolean,
  generations: Record<string, number>,
): Admission =>
  Object.freeze({ revision, admits, generations: Object.freeze(generations) });
