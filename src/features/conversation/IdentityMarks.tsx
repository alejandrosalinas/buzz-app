import { useSyncExternalStore } from "react";
import type { RelaySession } from "../relay/session";
import { ContributionBoundary, contributionKey } from "./ContributionBoundary";
import type { ContributionReader, IdentityMark } from "./contracts";

const none: readonly IdentityMark[] = [];
const noSubscribe = () => () => {};

/** Every active identity mark for `pubkey`, each in its own boundary so a
 * failing mark renders nothing and leaves the name and its row intact. */
export function IdentityMarks({
  registry,
  pubkey,
  profiles,
  className,
}: {
  registry: ContributionReader<IdentityMark> | undefined;
  pubkey: string;
  profiles: RelaySession["profiles"];
  className?: string | undefined;
}) {
  const marks = useSyncExternalStore(
    registry?.subscribe ?? noSubscribe,
    registry?.snapshot ?? (() => none),
    registry?.snapshot ?? (() => none),
  );
  if (!marks.length) return null;
  return (
    <span className={className}>
      {marks.map((mark) => (
        <ContributionBoundary key={contributionKey(mark)} fallback={null}>
          <mark.component pubkey={pubkey} profiles={profiles} />
        </ContributionBoundary>
      ))}
    </span>
  );
}
