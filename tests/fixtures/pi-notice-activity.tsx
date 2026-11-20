// Pi's own projection (piTurns) of synthetic durable entries, rendered by the
// shared ActivityTranscript. Acceptance evidence only: no host, relay or model.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { type PiEntry, piTurns } from "../../src/bundled/pi/transcript";
import { ActivityTranscript } from "../../src/features/agents/ActivityTranscript";
import { fallbackNotice } from "../../src/features/agents/gateway/route";
import { createAppearance } from "../../src/shared/theme/service";
import { useKeyboardFocusVisibility } from "../../src/shared/design-system/useKeyboardFocusVisibility";
import "../../src/shared/styles/globals.css";

createAppearance();
// The runner's own notice and the host's own failure, unchanged: no new copy.
const NOTICE = fallbackNotice({
  kind: "blocked",
  revision: 1,
  gatewayOrigin: "https://gateway.test",
  reason: "gateway_error",
  message: "",
});
// As host.mjs fails a turn with no model, before Pi has its prompt.
const NO_MODEL =
  "This agent has no model. Choose a provider and model in its Identity tab.";
const T = 1793910000000;
const wake = (id: number, text: string, notice?: string): PiEntry => ({
  id,
  kind: "pi.user",
  ...(notice ? { notice } : {}),
  model: [
    {
      role: "user",
      content: `<buzz-event>\nFrom: Timer\nContent: ${text}\nTags: []\n</buzz-event>`,
      timestamp: T + id * 1000,
    },
  ],
});
const answer = (
  id: number,
  content: NonNullable<NonNullable<PiEntry["model"]>[number]["content"]>,
  more: Record<string, unknown>,
): PiEntry => ({
  id,
  kind: "pi.assistant",
  model: [
    {
      role: "assistant",
      content,
      timestamp: T + id * 1000,
      model: "claude-x",
      ...more,
    },
  ],
});
const text = (value: string) => [{ type: "text", text: value }];

/** Each scenario: oldest-first entries, and whether its run still works. */
type Scenario = (finished: boolean) => [PiEntry[], boolean];
const SCENARIOS: Record<"done" | "stopped" | "error" | "overlap", Scenario> = {
  done: () => [
    [
      wake(1, "Daily summary", NOTICE),
      answer(2, text("Summary posted."), { stopReason: "stop" }),
    ],
    false,
  ],
  stopped: () => [
    [
      wake(1, "Daily summary", NOTICE),
      answer(2, text("Started the summ"), { stopReason: "aborted" }),
    ],
    false,
  ],
  error: () => [
    [
      wake(1, "Daily summary", NOTICE),
      answer(2, [], {
        stopReason: "error",
        errorMessage: "Rate limited by the provider",
      }),
    ],
    false,
  ],
  // A noted wake that failed before Pi had its prompt, while an earlier run
  // in the same conversation goes on: its tool result, a steer and its answer
  // come after the notice.
  overlap: (finished) => [
    [
      wake(1, "Check the build"),
      answer(
        2,
        [
          {
            type: "toolCall",
            id: "c1",
            name: "bash",
            arguments: { command: "ls" },
          },
        ],
        {
          stopReason: "toolUse",
        },
      ),
      {
        id: 3,
        kind: "buzz.notice",
        notice: NOTICE,
        error: NO_MODEL,
        at: T + 3000,
      },
      {
        id: 4,
        kind: "pi.tool-result",
        model: [
          {
            role: "toolResult",
            toolCallId: "c1",
            content: text("build.log"),
            isError: false,
            timestamp: T + 4000,
          },
        ],
      },
      {
        id: 5,
        kind: "pi.user",
        model: [
          {
            role: "user",
            content: `<new-message-arrived-while-you-were-working>\n${JSON.stringify({ pubkey: "b".repeat(64) })}\nRequest: "Include the test count"\n</new-message-arrived-while-you-were-working>`,
            timestamp: T + 5000,
          },
        ],
      },
      ...(finished
        ? [
            answer(6, text("The build passed: 42 tests."), {
              stopReason: "stop",
            }),
          ]
        : []),
    ],
    !finished,
  ],
};

const params = new URLSearchParams(location.search);
function Fixture() {
  useKeyboardFocusVisibility();
  const [scenario, setScenario] = useState(() => {
    const named = params.get("scenario");
    return named && named in SCENARIOS
      ? (named as keyof typeof SCENARIOS)
      : "overlap";
  });
  const [finished, setFinished] = useState(false);
  const [entries, working] = SCENARIOS[scenario](finished);
  const turns = piTurns(
    entries,
    { conversation: 1, channelId: "chan", root: "root" },
    working,
  );
  return (
    <main className="flex h-dvh flex-col">
      <div
        role="toolbar"
        aria-label="Fixture controls"
        className="flex flex-wrap gap-2 border-b p-2 text-body-sm"
      >
        {(Object.keys(SCENARIOS) as (keyof typeof SCENARIOS)[]).map((name) => (
          <button
            key={name}
            type="button"
            aria-pressed={scenario === name}
            onClick={() => setScenario(name)}
          >
            {name}
          </button>
        ))}
        <button
          type="button"
          aria-pressed={finished}
          onClick={() => setFinished((value) => !value)}
        >
          Earlier run answers
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <ActivityTranscript
          transcript={{ turns }}
          agentName="Pi fixture"
          state={() => (working ? "working" : undefined)}
        />
      </div>
    </main>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(<Fixture />);
