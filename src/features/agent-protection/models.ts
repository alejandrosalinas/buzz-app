import type { ReviewText } from "./json-stream";
export type ReviewModel = Readonly<{
  runtime: string;
  provider?: string;
  id: string;
}>;
export type ReviewModelChoice = Readonly<{
  provider?: string;
  id: string;
  label: string;
}>;
import type { HostProcess, HostProcessOptions } from "../host/service";
/** Launches only a review worker declared by the protecting plugin. It lasts
 * as long as that plugin's protection, which kills what it launched. */
export type ProtectedSpawn = (
  options: Omit<HostProcessOptions, "protection" | "protectedAgent">,
) => Promise<HostProcess>;
/** Plugin-owned instructions and evidence, separate from runtime credentials. */
export type ReviewPrompt = Readonly<{
  system: string;
  input: ReviewText;
  outputSchema?: Readonly<Record<string, unknown>>;
}>;
/** Runtime-owned inference uses its configured credentials, with no tools.
 * `signal` cancels one completion; `spawn` is the same for each one while
 * its protection lasts, so a runtime may keep one worker for them all. */
export type ReviewModelProvider = Readonly<{
  label: string;
  models(): Promise<readonly ReviewModelChoice[]>;
  complete(
    model: Omit<ReviewModel, "runtime">,
    prompt: ReviewPrompt,
    signal: AbortSignal,
    spawn?: ProtectedSpawn,
  ): Promise<{ text: string; model: Omit<ReviewModel, "runtime"> }>;
}>;
