import { expect, it } from "vitest";
import { modelChoice } from "./models";
import { modelFamily } from "../../../features/agents/ModelFamilyMenu";

it.each([
  ["Sol 6", "OpenAI"],
  ["Sol 6.1", "OpenAI"],
  ["Luna 6", "OpenAI"],
  ["Astra 6", "OpenAI"],
  ["Sonnet 5.5", "Claude"],
  ["Opus 5.5", "Claude"],
  ["Grok 4.7", "Grok"],
  ["GLM 5.3", "GLM"],
  ["GLM 5.3 Flash", "GLM"],
  ["Kimi K3", "Kimi"],
  ["DeepSeek 4.1 Flash", "DeepSeek"],
  ["Gemini 3 Pro", "Gemini"],
  ["Claude Sonnet 5", "Claude"],
  ["GPT-6", "OpenAI"],
  ["Future Model", "Other"],
  ["Solstice", "Other"],
  ["constructor", "Other"],
])(
  "maps the Builderlab catalog alias %s to %s without rewriting its identity",
  (displayName, family) => {
    const choice = modelChoice({
      id: "opaque-provider-id",
      displayName,
      supportedReasoningEfforts: ["high"],
      fast: false,
    });
    expect(choice).toMatchObject({
      id: "opaque-provider-id",
      label: displayName,
    });
    expect(modelFamily(choice)).toBe(family);
  },
);

it("carries the catalog's fast marker to the picker choice", () => {
  const model = {
    id: "kimi-k3-1-pro-cerebras",
    displayName: "Kimi K3.1 Pro (Cerebras)",
    supportedReasoningEfforts: ["low"],
  };
  expect(modelChoice({ ...model, fast: true })).toMatchObject({ fast: true });
  expect(modelChoice({ ...model, fast: false })).not.toHaveProperty("fast");
});
