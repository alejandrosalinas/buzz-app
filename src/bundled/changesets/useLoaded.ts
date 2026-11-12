import { useEffect, useReducer, useState } from "react";
import { Unreadable } from "./git";

type Loaded<T> = { value?: T; error?: string; final?: true };

/** Runs `load` again whenever `deps` change, and on `retry`, which a failure
 * trying again cannot fix leaves out. Without a `load` there is nothing to read. */
export function useLoaded<T>(
  load: (() => Promise<T>) | undefined,
  deps: readonly unknown[],
) {
  const [attempt, retry] = useReducer((count: number) => count + 1, 0);
  const [state, setState] = useState<Loaded<T>>({});
  // biome-ignore lint/correctness/useExhaustiveDependencies: Callers list what `load` reads.
  useEffect(() => {
    setState({});
    if (!load) return;
    let live = true;
    load().then(
      (value) => live && setState({ value }),
      (error) =>
        live &&
        setState({
          error: error instanceof Error ? error.message : String(error),
          ...(error instanceof Unreadable ? { final: true as const } : {}),
        }),
    );
    return () => {
      live = false;
    };
  }, [...deps, attempt]);
  return {
    value: state.value,
    error: state.error,
    retry: state.final ? undefined : retry,
  };
}
