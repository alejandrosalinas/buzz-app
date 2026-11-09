import type { ModelChoice } from "../../../features/agents/ModelPicker";
import type { RemoteAgentModel } from "../agents/client";

export const effortLabel = (id: string) =>
  id === "xhigh" ? "Extra high" : `${id.charAt(0).toUpperCase()}${id.slice(1)}`;

// Builderlab owns these catalog aliases. Keep this mapping in sync with its
// catalog information until the API supplies a model-family field. Unknown
// names fall through to shared inference; labels, IDs and efforts remain server-owned.
const families = new Map([
  ["sol", "OpenAI"],
  ["luna", "OpenAI"],
  ["astra", "OpenAI"],
  ["sonnet", "Claude"],
  ["opus", "Claude"],
  ["grok", "Grok"],
  ["glm", "GLM"],
  ["kimi", "Kimi"],
  ["deepseek", "DeepSeek"],
]);

export function modelChoice(model: RemoteAgentModel): ModelChoice {
  const alias = model.displayName
    .trim()
    .toLowerCase()
    .split(/[\s._-]/)[0];
  const family = families.get(alias ?? "");
  return {
    id: model.id,
    label: model.displayName,
    ...(family ? { family } : {}),
    ...(model.fast ? { fast: true } : {}),
  };
}
