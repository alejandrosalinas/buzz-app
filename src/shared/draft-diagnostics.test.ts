import { expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: vi.fn(),
}));

it("bounds history and pending saves without retaining revisions or coordinates", async () => {
  const { invoke } = await import("@tauri-apps/api/core");
  const { traceDraft } = await import("./draft-diagnostics");
  let release!: () => void;
  const started = vi
    .mocked(invoke)
    .mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    )
    .mockResolvedValue(undefined);
  traceDraft("private-scope", "draft:private-channel", "changed", 1);
  await Promise.resolve();
  expect(started).toHaveBeenCalledTimes(1);
  try {
    for (let index = 0; index < 150; index++) {
      traceDraft("private-scope", "draft:private-channel", "persist", 1, {
        expected: '"private text"',
        current: null,
        next: '"private text"',
        flags: 1,
      });
      traceDraft("private-scope", "draft:private-channel", "changed", 1);
    }
    expect(started).toHaveBeenCalledTimes(1);
  } finally {
    release();
  }
  await vi.waitFor(() => expect(started).toHaveBeenCalledTimes(2));
  const payload = started.mock.calls[1]?.[1] as { records: unknown[] };
  expect(payload.records).toHaveLength(100);
  expect(JSON.stringify(payload)).not.toContain("private");
  expect(payload.records.at(-2)).toMatchObject({
    operation: "persist",
    expected: "string",
    current: "missing",
    next: "string",
    sameExpected: false,
    sameNext: false,
  });
});
