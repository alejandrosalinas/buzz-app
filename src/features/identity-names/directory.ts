import { scopeKeys, type NamingIdentity } from "./policy";
import type { NameProvider, NameSource, NamingPolicy } from "./service";
import type { LocalAgents } from "../agents/local";
import { relayOrigin } from "../communities/destination";

function sameCommunity(left: string, right: string) {
  try {
    return relayOrigin(left) === relayOrigin(right);
  } catch {
    return false;
  }
}

// A frozen candidate array, such as a channel's member list, cannot change, so
// its normalized scope is kept instead of sorting and joining it per lookup.
const normalized = new WeakMap<
  readonly string[],
  { selected: ReadonlySet<string>; selection: readonly string[]; id: string }
>();
function normalize(candidates: readonly string[]) {
  let scope = normalized.get(candidates);
  if (!scope) {
    const selected = new Set(candidates.map((key) => key.toLowerCase()));
    const selection = [...selected].sort();
    scope = { selected, selection, id: selection.join(":") };
    if (Object.isFrozen(candidates)) normalized.set(candidates, scope);
  }
  return scope;
}

/** Local agent names win only in their community. Names never grant control. */
export function createNameProvider(
  policy: NamingPolicy,
  local?: LocalAgents,
): NameProvider {
  let base:
    | {
        inputs: readonly unknown[];
        names: Map<string, string>;
        identities: Map<string, NamingIdentity>;
        // Recently used scopes (LRU), so a hot scope survives interleaved lookups
        // and a sidebar pass over every DM's participants hits on the next pass.
        scopes: Map<
          string | undefined,
          {
            facts: string | undefined;
            labels: ReturnType<NamingPolicy["resolve"]>;
          }
        >;
        // Recently used scopes' labels for historical keys outside them (LRU).
        // A view can show many, so they stay out of the scope LRU above.
        outsiders: Map<
          string | undefined,
          {
            facts: string | undefined;
            labels: Map<
              string,
              ReturnType<ReturnType<NamingPolicy["resolve"]>["get"]>
            >;
          }
        >;
      }
    | undefined;
  const current = (source: NameSource) => {
    const native = local?.snapshot();
    const relayUrl = source.relayUrl;
    const library = source.agentLibrary.snapshot();
    const profiles = source.profiles.snapshot();
    const inputs = [library, native, profiles, relayUrl, source.viewer];
    if (base && inputs.every((input, index) => input === base?.inputs[index]))
      return base;
    const names = new Map<string, string>();
    if (library.status === "ready") {
      for (const row of library.identities) {
        const key = row.pubkey.toLowerCase();
        if (!names.has(key)) {
          const profile = profiles.get(key);
          const profileName = profile?.nameIsFallback
            ? undefined
            : profile?.name.trim();
          names.set(
            key,
            // A signed public agent profile is the cross-client name source. The
            // host's saved-library alias remains a fallback; same-community
            // native settings still override it below.
            profile?.isAgent && profileName
              ? profileName
              : row.name.trim() || profileName || "Agent",
          );
        }
      }
    }
    if (relayUrl && native?.status === "ready") {
      const seen = new Set<string>();
      for (const agent of native.agents) {
        const key = agent.pubkey.toLowerCase();
        if (seen.has(key) || !sameCommunity(agent.relayUrl, relayUrl)) continue;
        seen.add(key);
        const name = agent.name.trim();
        if (name) names.set(key, name);
      }
    }
    const identities = new Map<string, NamingIdentity>(
      [...profiles]
        .filter(([, profile]) => !profile.nameIsFallback)
        .map(([pubkey, profile]) => [pubkey, { pubkey, ...profile }]),
    );
    for (const [pubkey, name] of names) {
      identities.set(pubkey, {
        ...profiles.get(pubkey),
        pubkey,
        name,
        isAgent: true,
      });
    }
    base = {
      inputs,
      names,
      identities,
      scopes: new Map(),
      outsiders: new Map(),
    };
    return base;
  };
  const resolveLabels = (
    source: NameSource,
    selection: readonly string[] | undefined,
    displayFacts: readonly NamingIdentity[] | undefined,
  ) => {
    const { identities } = current(source);
    // View-local labels (authored draft text or cross-community management rows)
    // supplement display facts only; they never select recipients or grant control.
    const displayed = (displayFacts ?? []).map((fact) => {
      const key = fact.pubkey.toLowerCase();
      return {
        ...source.profiles.snapshot().get(key),
        ...identities.get(key),
        ...fact,
        pubkey: key,
      };
    });
    const displayedKeys = new Set(displayed.map((fact) => fact.pubkey));
    // A scope only labels its selection and its agents' owners. Look those up
    // instead of passing every cached identity, so a scope costs its own size
    // rather than the whole profile cache.
    let rows: Iterable<NamingIdentity> = identities.values();
    if (selection) {
      const facts = new Map<string, NamingIdentity[]>();
      for (const fact of displayed)
        facts.set(fact.pubkey, [...(facts.get(fact.pubkey) ?? []), fact]);
      const keys = scopeKeys(selection, (key) => {
        const row = identities.get(key);
        return [...(row ? [row] : []), ...(facts.get(key) ?? [])];
      });
      rows = [...keys].flatMap((key) => {
        const row = identities.get(key);
        return row ? [row] : [];
      });
    }
    return policy.resolve(
      [
        ...[...rows].filter((row) => !displayedKeys.has(row.pubkey)),
        ...displayed,
      ],
      source.viewer,
      selection,
    );
  };
  const labels = (
    source: NameSource,
    selection: readonly string[] | undefined,
    id: string | undefined,
    displayFacts: readonly NamingIdentity[] | undefined,
    facts: string | undefined,
  ) => {
    const { scopes } = current(source);
    const cached = scopes.get(id);
    if (cached && cached.facts === facts) {
      scopes.delete(id);
      scopes.set(id, cached);
      return cached.labels;
    }
    const resolved = resolveLabels(source, selection, displayFacts);
    scopes.delete(id);
    if (scopes.size >= 256) scopes.delete(scopes.keys().next().value);
    scopes.set(id, { facts, labels: resolved });
    return resolved;
  };
  return {
    id: policy.id,
    ...(local ? { subscribe: local.subscribe } : {}),
    activate(source) {
      return source.agentLibrary.retain();
    },
    scope(source, candidates, displayFacts) {
      const { selected, selection, id } =
        (candidates && normalize(candidates)) ?? {};
      // Views rebuild equal display facts on every render, so scopes compare
      // the fields that naming reads.
      const facts =
        displayFacts &&
        JSON.stringify(
          displayFacts.map((fact) => [
            fact.pubkey,
            fact.name,
            fact.isAgent,
            fact.ownerPubkey,
          ]),
        );
      // Include the requested identity even for historical non-member references.
      const outside = (selected: ReadonlySet<string>, key: string) => {
        const { outsiders } = current(source);
        let scoped = outsiders.get(id);
        outsiders.delete(id);
        if (!scoped || scoped.facts !== facts) {
          scoped = { facts, labels: new Map() };
          if (outsiders.size >= 8)
            outsiders.delete(outsiders.keys().next().value);
        }
        outsiders.set(id, scoped);
        if (!scoped.labels.has(key))
          scoped.labels.set(
            key,
            resolveLabels(source, [...selected, key], displayFacts).get(key),
          );
        return scoped.labels.get(key);
      };
      return (pubkey) => {
        const key = pubkey.toLowerCase();
        const label =
          selected && !selected.has(key)
            ? outside(selected, key)
            : labels(source, selection, id, displayFacts, facts).get(key);
        if (label) return label;
        const name = current(source).names.get(key);
        return name ? { name } : undefined;
      };
    },
  };
}
