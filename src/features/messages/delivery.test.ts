import { expect, it } from "vitest";
import { deliveryFeedback } from "./delivery";

it("keeps unconfirmed optimistic messages quiet for ten seconds", () => {
  for (const delivery of ["sending", "accepted", "unknown"] as const) {
    expect(
      deliveryFeedback({ delivery, createdAt: 100 }, 109999),
    ).toBeUndefined();
    expect(deliveryFeedback({ delivery, createdAt: 100 }, 110000)).toBeTruthy();
  }
});
it("shows a failed send at once, inside the grace", () => {
  expect(
    deliveryFeedback({ delivery: "failed", createdAt: 100 }, 100_000),
  ).toBe("Couldn’t send this message.");
});
it("never adds success labels to confirmed or remote messages", () => {
  expect(
    deliveryFeedback({ delivery: "seen", createdAt: 100 }, 999999),
  ).toBeUndefined();
  expect(deliveryFeedback({ createdAt: 100 }, 999999)).toBeUndefined();
});
it("distinguishes rejection from delayed confirmation", () => {
  expect(deliveryFeedback({ delivery: "failed", createdAt: 100 }, 110000)).toBe(
    "Couldn’t send this message.",
  );
  expect(
    deliveryFeedback({ delivery: "accepted", createdAt: 100 }, 110000),
  ).toBe("Delivery not yet confirmed.");
});
