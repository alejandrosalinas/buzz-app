import userEvent from "@testing-library/user-event";
// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  cleanup,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { ShareModelPicker } from "./ShareModelPicker";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const catalog = {
  gpuName: "Fixture GPU",
  vramDisplay: "32 GB",
  recommended: "fixture/model:Q4",
  entries: [
    {
      model: "fixture/model:Q4",
      name: "Fixture model",
      size: "6GB",
      installed: false,
      curated: true,
      fit: "comfortable",
    },
  ],
};
function Fixture() {
  const [model, setModel] = useState("");
  const [auto, setAuto] = useState(true);
  return (
    <ShareModelPicker
      model={model}
      auto={auto}
      onChange={(value) => {
        setModel(value);
        setAuto(false);
      }}
      onReset={() => setAuto(true)}
      disabled={false}
    />
  );
}
it("selects the SDK-backed recommendation and discloses the download before sharing", async () => {
  invoke.mockResolvedValue(catalog);
  render(<Fixture />);
  await screen.findByText("Fixture GPU");
  await screen.findByText("Fixture GPU");
  expect(screen.getByText("32 GB")).toBeVisible();
  expect(screen.getAllByText("Auto")).toHaveLength(1);
  expect(
    screen.getByRole("combobox", { name: "Model to share" }),
  ).toHaveTextContent("Auto");
  expect(screen.getByText("Download 6GB")).toBeVisible();
  expect(screen.queryByText("comfortable")).not.toBeInTheDocument();
  expect(screen.getByText("32 GB")).toHaveAttribute("data-fit", "comfortable");

  expect(invoke).toHaveBeenCalledWith("mesh_compute_catalog");
  await userEvent.click(
    screen.getByRole("combobox", { name: "Model to share" }),
  );
  await userEvent.click(
    await screen.findByRole("option", { name: /Fixture model.*recommended/ }),
  );
  expect(
    screen.getByRole("combobox", { name: "Model to share" }),
  ).toHaveTextContent("Fixture model");
  expect(screen.queryByText("Manual")).not.toBeInTheDocument();
});
it("labels each option's fit and refuses models too large for this machine", async () => {
  invoke.mockResolvedValue({
    ...catalog,
    entries: [
      ...catalog.entries,
      {
        model: "fixture/huge:Q8",
        name: "Huge model",
        size: "90GB",
        installed: false,
        curated: true,
        fit: "too_large",
      },
    ],
  });
  render(<Fixture />);
  await screen.findByText("Fixture GPU");
  fireEvent.click(screen.getByRole("combobox"));
  expect(
    await screen.findByRole("option", {
      name: /Fixture model.*fits comfortably/,
    }),
  ).not.toHaveAttribute("aria-disabled", "true");
  expect(
    screen.getByRole("option", {
      name: /Huge model.*too large for this machine/,
    }),
  ).toHaveAttribute("aria-disabled", "true");
});
it("keeps manual selection usable on catalog failure and retries the catalog", async () => {
  invoke
    .mockRejectedValueOnce("Catalog unavailable")
    .mockResolvedValue(catalog);
  render(<Fixture />);
  await screen.findByText("Catalog unavailable");
  await userEvent.click(
    screen.getByRole("combobox", { name: "Model to share" }),
  );
  await userEvent.click(
    await screen.findByRole("option", { name: "Custom model or local GGUF" }),
  );
  fireEvent.change(
    screen.getByLabelText("Model reference or local GGUF path"),
    { target: { value: "/local.gguf" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Retry model catalog" }));
  await screen.findByText("Fixture GPU");
  expect(
    screen.getByLabelText("Model reference or local GGUF path"),
  ).toHaveValue("/local.gguf");
});
it("ignores a catalog response after unmount", async () => {
  let resolve!: (value: typeof catalog) => void;
  const gate = new Promise<typeof catalog>((done) => {
    resolve = done;
  });
  invoke.mockReturnValue(gate);
  const onChange = vi.fn();
  const view = render(
    <ShareModelPicker
      model=""
      auto={true}
      onReset={() => {}}
      onChange={onChange}
      disabled={false}
    />,
  );
  await waitFor(() => expect(invoke).toHaveBeenCalled());
  view.unmount();
  resolve(catalog);
  await gate;
  expect(onChange).not.toHaveBeenCalled();
});

it("bounds loading and ignores a late response after timeout", async () => {
  vi.useFakeTimers();
  let release!: (value: typeof catalog) => void;
  invoke.mockReturnValue(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  try {
    render(<Fixture />);
    expect(screen.getByText("Loading model choices…")).toBeInTheDocument();
    await act(async () => {
      vi.advanceTimersByTime(30000);
    });
    expect(screen.getByRole("alert")).toHaveTextContent("took too long");
    await act(async () => {
      release(catalog);
    });
    expect(screen.queryByText("Fixture GPU")).not.toBeInTheDocument();
    invoke.mockResolvedValue(catalog);
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Retry model catalog" }),
      );
    });
    expect(
      screen.getByRole("combobox", { name: "Model to share" }),
    ).toHaveTextContent("Auto");
  } finally {
    cleanup();
    vi.useRealTimers();
  }
});

it("resets a custom selection to the device recommendation without keeping custom mode", async () => {
  invoke
    .mockRejectedValueOnce("Catalog unavailable")
    .mockResolvedValue(catalog);
  render(<Fixture />);
  await screen.findByText("Catalog unavailable");
  await userEvent.click(
    screen.getByRole("combobox", { name: "Model to share" }),
  );
  await userEvent.click(
    await screen.findByRole("option", { name: "Custom model or local GGUF" }),
  );
  fireEvent.change(
    screen.getByLabelText("Model reference or local GGUF path"),
    { target: { value: "/old.gguf" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Retry model catalog" }));
  await screen.findByText("Fixture GPU");
  fireEvent.click(screen.getByRole("combobox", { name: "Model to share" }));
  await userEvent.click(await screen.findByRole("option", { name: "Auto" }));
  expect(
    screen.queryByLabelText("Model reference or local GGUF path"),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("combobox", { name: "Model to share" }),
  ).toHaveTextContent("Auto");
});

it("reset remains available during sharing and delegates persistence instead of changing the running model", async () => {
  invoke.mockResolvedValue(catalog);
  const onReset = vi.fn();
  const onChange = vi.fn();
  render(
    <ShareModelPicker
      model="/running.gguf"
      auto={false}
      onChange={onChange}
      onReset={onReset}
      disabled={true}
      resetDisabled={false}
    />,
  );
  const picker = await screen.findByRole("combobox", {
    name: "Model to share",
  });
  expect(picker).toBeEnabled();
  fireEvent.click(picker);
  const reset = await screen.findByRole("option", {
    name: "Auto",
  });
  await userEvent.click(reset);
  expect(onReset).toHaveBeenCalledOnce();
  expect(onChange).not.toHaveBeenCalled();
});
it("controlled Auto does not write a recommendation as an override", async () => {
  invoke.mockResolvedValue(catalog);
  const onChange = vi.fn();
  render(
    <ShareModelPicker
      model="old/recommendation"
      auto={true}
      onChange={onChange}
      onReset={() => {}}
      disabled={false}
    />,
  );
  await screen.findByText("Fixture GPU");
  expect(onChange).not.toHaveBeenCalled();
  expect(
    screen.queryByRole("button", { name: "Reset to Auto" }),
  ).not.toBeInTheDocument();
});

it("shows a next-start notice only when Auto differs from the running model", async () => {
  invoke.mockResolvedValue(catalog);
  const view = render(
    <ShareModelPicker
      model={catalog.recommended}
      auto={true}
      onChange={() => {}}
      onReset={() => {}}
      runningModel={catalog.recommended}
      disabled={true}
    />,
  );
  await screen.findByText("Fixture GPU");
  expect(
    screen.queryByText("Auto selection applies next time sharing starts."),
  ).not.toBeInTheDocument();
  view.rerender(
    <ShareModelPicker
      model="/override.gguf"
      auto={true}
      onChange={() => {}}
      onReset={() => {}}
      runningModel="/override.gguf"
      disabled={true}
    />,
  );
  expect(
    screen.getByText("Auto selection applies next time sharing starts."),
  ).toBeInTheDocument();
});

it("shows a warning only for a model that exceeds the machine's memory budget", async () => {
  invoke.mockResolvedValue({
    ...catalog,
    entries: [{ ...catalog.entries[0], fit: "too_large" }],
  });
  render(<Fixture />);
  const memory = await screen.findByText("32 GB");
  expect(memory).toHaveAttribute("data-fit", "too_large");
  expect(screen.getByText("Too large").parentElement).toBe(
    memory.parentElement,
  );
  expect(
    screen.queryByRole("button", { name: "Advanced" }),
  ).not.toBeInTheDocument();
});

it("keeps Auto selected while the catalog loads and after a recommendation arrives", async () => {
  let release!: (value: typeof catalog) => void;
  const pending = new Promise<typeof catalog>((resolve) => {
    release = resolve;
  });
  invoke.mockReturnValue(pending);
  const props = {
    auto: true,
    disabled: false,
    onChange: vi.fn(),
    onReset: vi.fn(),
  };
  const view = render(
    <ShareModelPicker
      {...props}
      model="saved/model"
      runningModel="running/model"
    />,
  );
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("mesh_compute_catalog"),
  );
  expect(
    screen.getByRole("combobox", { name: "Model to share" }),
  ).toHaveTextContent("Auto");
  expect(
    screen.queryByLabelText("Model reference or local GGUF path"),
  ).not.toBeInTheDocument();
  expect(screen.queryByText("Chooses on start")).not.toBeInTheDocument();
  view.rerender(<ShareModelPicker {...props} model="" />);
  expect(
    screen.getByRole("combobox", { name: "Model to share" }),
  ).toHaveTextContent("Auto");
  expect(
    screen.queryByLabelText("Model reference or local GGUF path"),
  ).not.toBeInTheDocument();
  await act(async () => {
    release(catalog);
    await pending;
  });
  expect(
    screen.getByRole("combobox", { name: "Model to share" }),
  ).toHaveTextContent("Auto");
});
