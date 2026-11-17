// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { AISettings, Checking, runsOnDetails, UsesLine } from "./AISettings";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

it.each([
  {
    recommendedBy: "Example Co",
    description: undefined,
    expected: "Recommended by Example Co. Codex: Model A · High",
  },
  {
    recommendedBy: undefined,
    description: undefined,
    expected: "Use recommended settings. Codex: Model A · High",
  },
  {
    recommendedBy: "Example Co",
    description: "Prioritizes compatibility.",
    expected:
      "Recommended by Example Co. Prioritizes compatibility. Codex: Model A · High",
  },
  {
    recommendedBy: undefined,
    description: "Prioritizes compatibility.",
    expected: "Prioritizes compatibility. Codex: Model A · High",
  },
])(
  "describes Automatic as $expected and preserves manual control",
  async ({ recommendedBy, description, expected }) => {
    vi.stubEnv(
      "VITE_BUZZ_RECOMMENDED_AGENT",
      JSON.stringify({
        ...(recommendedBy ? { recommendedBy } : {}),
        ...(description ? { description } : {}),
        candidates: [
          {
            harness: "codex",
            model: "model-a",
            effort: "high",
            label: "Model A",
          },
        ],
      }),
    );
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <AISettings
        automatic
        modelName="Model A"
        model={
          <UsesLine
            icon={undefined}
            title="Codex"
            candidate={{ label: "Model A", effort: "high" }}
          />
        }
        onChange={onChange}
      >
        <p>Custom rows</p>
      </AISettings>,
    );
    const control = screen.getByRole("combobox", { name: "AI setup" });
    expect(control).toHaveAccessibleDescription("Set to Model A (recommended)");
    expect(screen.queryByText(/recommended by/i)).not.toBeInTheDocument();
    expect(
      screen.queryByText("Choose your own settings."),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Model A · High")).not.toBeInTheDocument();
    await user.click(control);
    const automatic = await screen.findByRole("option", {
      name: "Automatic",
    });
    expect(automatic).toHaveAccessibleDescription(expected);
    if (recommendedBy) {
      expect(
        within(automatic).getByText(
          new RegExp(`Recommended by ${recommendedBy}`),
        ),
      ).toBeVisible();
    }
    if (description) {
      expect(
        within(automatic).getByText(new RegExp(description)),
      ).toBeVisible();
    } else if (!recommendedBy) {
      expect(
        within(automatic).getByText("Use recommended settings."),
      ).toBeVisible();
    }
    expect(
      screen.getByRole("option", { name: "Custom" }),
    ).toHaveAccessibleDescription("Choose your own settings.");
    await user.click(screen.getByRole("option", { name: "Custom" }));
    expect(onChange).toHaveBeenCalledWith(false);
  },
);

it("holds back Checking a second, so a quick check doesn't flash it", () => {
  vi.useFakeTimers();
  render(<Checking />);
  expect(screen.queryByText("Checking this computer…")).not.toBeInTheDocument();
  act(() => vi.advanceTimersByTime(1000));
  expect(screen.getByText("Checking this computer…")).toBeInTheDocument();
});

it("shows model attribution before fallback details without nested controls", async () => {
  vi.stubEnv(
    "VITE_BUZZ_RECOMMENDED_AGENT",
    JSON.stringify({
      recommendedBy: "Example Co",
      description: "Prioritizes compatibility.",
      candidates: [
        {
          harness: "goose",
          provider: "example",
          model: "model-b",
          label: "Model B",
          effort: "high",
        },
      ],
    }),
  );
  const user = userEvent.setup();
  render(
    <AISettings
      automatic
      modelName="Model B"
      model={
        <UsesLine
          icon={undefined}
          title="Goose"
          candidate={{ label: "Model B", effort: "high" }}
          skipped="Codex"
        />
      }
      onChange={() => {}}
    >
      <p>Custom rows</p>
    </AISettings>,
  );
  const trigger = screen.getByRole("combobox", { name: "AI setup" });
  expect(trigger).toHaveAccessibleDescription("Set to Model B (recommended)");
  expect(screen.queryByTitle("Model B · High")).not.toBeInTheDocument();
  await user.click(trigger);
  const automatic = await screen.findByRole("option", { name: "Automatic" });
  expect(automatic).toHaveAccessibleDescription(
    "Recommended by Example Co. Prioritizes compatibility. Goose: Model B · High Buzz’s usual pick, Codex, isn’t set up on this computer, so this agent uses Model B.",
  );
  expect(within(automatic).queryByRole("button")).not.toBeInTheDocument();
  // The full value remains available on hover.
  expect(screen.getByTitle("Model B · High")).toBeInTheDocument();
});

it("keeps checking and unavailable status visible outside the dropdown", () => {
  vi.useFakeTimers();
  const type = { title: "Goose" };
  const props = { automatic: true, onChange: () => {} };
  const { rerender } = render(
    <AISettings {...props} {...runsOnDetails(type, undefined)}>
      Custom rows
    </AISettings>,
  );
  const status = screen.getByRole("status");
  act(() => vi.advanceTimersByTime(1000));
  expect(status).toHaveTextContent("Checking this computer…");
  rerender(
    <AISettings {...props} {...runsOnDetails(type, null)}>
      Custom rows
    </AISettings>,
  );
  expect(screen.getByRole("status")).toBe(status);
  expect(status).toHaveTextContent(
    "No recommended model is available, so this uses Goose’s default.",
  );
  rerender(
    <AISettings
      {...props}
      {...runsOnDetails(type, {
        harness: "goose",
        model: "model-b",
        label: "Model B",
        effort: "high",
      })}
    >
      Custom rows
    </AISettings>,
  );
  expect(screen.getByRole("status")).toBe(status);
  expect(status).toBeEmptyDOMElement();
  expect(screen.queryByText("Model B · High")).not.toBeInTheDocument();
});

it("shows the full Automatic model name and hides the byline in Custom", () => {
  const { rerender } = render(
    <AISettings automatic modelName="Model A" onChange={() => {}}>
      Custom rows
    </AISettings>,
  );
  const control = screen.getByRole("combobox", { name: "AI setup" });
  expect(control).toHaveAccessibleDescription("Set to Model A (recommended)");
  const name = "Atlas Reasoning Model — Extended Context Preview";
  rerender(
    <AISettings automatic modelName={name} onChange={() => {}}>
      Custom rows
    </AISettings>,
  );
  expect(control).toHaveAccessibleDescription(`Set to ${name} (recommended)`);
  expect(screen.getByTitle(`Set to ${name} (recommended)`)).toHaveTextContent(
    `Set to ${name} (recommended)`,
  );
  rerender(
    <AISettings automatic={false} modelName={name} onChange={() => {}}>
      Custom rows
    </AISettings>,
  );
  expect(control).not.toHaveAccessibleDescription();
  expect(
    screen.queryByTitle(`Set to ${name} (recommended)`),
  ).not.toBeInTheDocument();
  expect(screen.getByText("Custom rows")).toBeVisible();
});
