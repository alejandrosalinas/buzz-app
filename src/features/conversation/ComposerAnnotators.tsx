import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import type { Contribution } from "../../plugins/contributions";
import type { ComposerInputElement } from "../messages/composer-dom";
import {
  acceptedAnnotations,
  mergedAnnotations,
  type AnnotationMark,
} from "../messages/composer-annotations";
import { ContributionBoundary, contributionKey } from "./ContributionBoundary";
import type {
  AnnotationObservation,
  CompletionContext,
  ComposerAnnotation,
  ComposerAnnotator,
  ContributionReader,
} from "./contracts";

type Lane = Readonly<{ revision: number; marks: readonly AnnotationMark[] }>;

/** Publications for one destination of one editor. Retiring it revokes every
 * outstanding `publish` and clears the marks. */
function createSession(registry: ContributionReader<ComposerAnnotator>) {
  const lanes = new Map<Contribution<ComposerAnnotator>, Lane>();
  // A failed annotator's timers may still hold `publish`.
  const failed = new Set<Contribution<ComposerAnnotator>>();
  let element: ComposerInputElement | undefined;
  let current: AnnotationObservation | undefined;
  let frame: number | undefined;
  // Several annotators settling for one revision redraw once.
  const show = () => {
    if (frame !== undefined || !element) return;
    frame = requestAnimationFrame(() => {
      frame = undefined;
      if (!element || !current) return;
      const revision = current.revision;
      element.showAnnotations(
        revision,
        mergedAnnotations(
          registry
            .snapshot()
            .map((annotator) => lanes.get(annotator))
            .filter((lane) => lane?.revision === revision)
            .map((lane) => lane?.marks ?? []),
        ),
      );
    });
  };
  const drop = (annotator: Contribution<ComposerAnnotator>) => {
    if (lanes.delete(annotator)) show();
  };
  return {
    attach(next: ComposerInputElement) {
      element = next;
    },
    observe(observation: AnnotationObservation) {
      current = observation;
    },
    publish(
      annotator: Contribution<ComposerAnnotator>,
      observation: AnnotationObservation,
      annotations: readonly ComposerAnnotation[],
    ) {
      if (
        !element ||
        observation !== current ||
        failed.has(annotator) ||
        !registry.snapshot().includes(annotator)
      )
        return false;
      const marks = acceptedAnnotations(
        annotations,
        observation,
        annotator.key,
      );
      if (!marks) return false;
      const lane = { revision: observation.revision, marks };
      lanes.set(annotator, lane);
      show();
      return () => {
        if (lanes.get(annotator) !== lane) return;
        lanes.delete(annotator);
        // Underlines from an earlier revision keep following their text until
        // the next publication.
        if (lane.revision === current?.revision) show();
      };
    },
    drop,
    fail(annotator: Contribution<ComposerAnnotator>) {
      failed.add(annotator);
      drop(annotator);
    },
    retire() {
      if (frame !== undefined) cancelAnimationFrame(frame);
      lanes.clear();
      element?.showAnnotations(0, []);
      element = current = frame = undefined;
    },
  };
}
type Host = ReturnType<typeof createSession>;

/** Mounts each registered annotator against the focused composer's draft and
 * shows their validated marks. `epoch` names the destination: changing it, or
 * `enabled`, revokes every publication and clears the marks. */
export function ComposerAnnotators({
  registry,
  input,
  enabled,
  epoch,
  ...context
}: CompletionContext & {
  registry: ContributionReader<ComposerAnnotator>;
  input: RefObject<ComposerInputElement | null>;
  enabled: boolean;
  epoch: string;
}) {
  const annotators = useSyncExternalStore(
    registry.subscribe,
    registry.snapshot,
    registry.snapshot,
  );
  const live = enabled && annotators.length > 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: A new destination starts a new session.
  const host = useMemo(
    () => createSession(registry),
    [registry, input, live, epoch],
  );
  // Annotators mount only once their session is attached and has observed.
  const [observed, setObserved] =
    useState<Readonly<{ host: Host; observation: AnnotationObservation }>>();
  useEffect(() => {
    const element = input.current;
    if (!element || !live) return;
    host.attach(element);
    const observe = () => {
      const next = element.annotationObservation();
      if (!next) return;
      host.observe(next);
      setObserved((last) =>
        last?.host === host && last.observation === next
          ? last
          : { host, observation: next },
      );
    };
    // Every editor transaction emits `select`; composition can end without one.
    element.addEventListener("select", observe);
    element.addEventListener("focus", observe);
    element.addEventListener("compositionend", observe);
    observe();
    return () => {
      element.removeEventListener("select", observe);
      element.removeEventListener("focus", observe);
      element.removeEventListener("compositionend", observe);
      host.retire();
    };
  }, [input, live, host]);
  if (!live || observed?.host !== host) return null;
  const { observation } = observed;
  return annotators.map((annotator) => (
    <ContributionBoundary
      key={contributionKey(annotator)}
      fallback={null}
      resetIdentity={host}
      onFailedChange={(failure) => {
        if (failure) host.fail(annotator);
      }}
    >
      <Annotator
        {...context}
        annotator={annotator}
        host={host}
        observation={observation}
      />
    </ContributionBoundary>
  ));
}

function Annotator({
  annotator,
  host,
  observation,
  ...context
}: CompletionContext & {
  annotator: Contribution<ComposerAnnotator>;
  host: Host;
  observation: AnnotationObservation;
}) {
  useEffect(() => () => host.drop(annotator), [host, annotator]);
  const publish = useCallback(
    (annotations: readonly ComposerAnnotation[]) =>
      host.publish(annotator, observation, annotations),
    [host, annotator, observation],
  );
  const Component = annotator.component;
  return <Component {...context} observation={observation} publish={publish} />;
}
