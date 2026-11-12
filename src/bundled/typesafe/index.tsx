// TypeSafe as a decision provider: the user's own TypeSafe key, kept and sent
// by native code. Settings > Decisions API shows its key form while it is
// selected.
import type { DecisionProvider } from "../../features/decisions/service";
import type { PluginModule } from "../../plugins/api";
import { nativeTypeSafe, TypeSafeKey, type TypeSafeNative } from "./key";
import { TypeSafeSettings } from "./TypeSafeSettings";

export const inject = ["decisions"];

/** The provider that answers with `typesafe`'s key. */
export const typesafeProvider = (typesafe: TypeSafeKey): DecisionProvider => ({
  id: "typesafe",
  label: "TypeSafe",
  showSettingsHeading: false,
  description: "Use your own TypeSafe API key.",
  status: typesafe.status,
  subscribe: typesafe.subscribe,
  decide: typesafe.decide,
  Settings: ({ active, grouped }) => (
    <TypeSafeSettings
      typesafe={typesafe}
      active={active}
      grouped={grouped ?? true}
    />
  ),
});

export function createApply(
  native: () => TypeSafeNative | undefined = nativeTypeSafe,
): PluginModule["apply"] {
  return (ctx) => {
    const typesafe = new TypeSafeKey(native());
    typesafe.load();
    ctx.decisions.registerProvider(typesafeProvider(typesafe));
  };
}
export const apply = createApply();
