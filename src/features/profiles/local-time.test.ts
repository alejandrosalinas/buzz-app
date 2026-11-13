import { describe, expect, it } from "vitest";
import { localTimeLabel, profileTimeZone } from "./local-time";

// ICU may separate the day period with a narrow no-break space.
const label = (...args: Parameters<typeof localTimeLabel>) =>
  localTimeLabel(...args)?.replace(/\s/g, " ");
const en = { locale: "en-US" };

describe("localTimeLabel", () => {
  it("leaves the difference out when asked", () => {
    expect(
      label(
        "Europe/London",
        new Date("2026-01-15T15:42:00Z"),
        "America/New_York",
        { ...en, difference: false },
      ),
    ).toBe("3:42 PM local time");
  });

  it("follows each zone's own daylight saving", () => {
    // US clocks change on March 8, 2026 and UK clocks on March 29.
    expect(
      label(
        "Europe/London",
        new Date("2026-01-15T15:42:00Z"),
        "America/New_York",
        en,
      ),
    ).toBe("3:42 PM local time · 5h ahead");
    expect(
      label(
        "Europe/London",
        new Date("2026-03-20T15:42:00Z"),
        "America/New_York",
        en,
      ),
    ).toBe("3:42 PM local time · 4h ahead");
    expect(
      label(
        "America/Los_Angeles",
        new Date("2026-07-01T19:42:00Z"),
        "Europe/London",
        en,
      ),
    ).toBe("12:42 PM local time · 8h behind");
  });

  it("shows half-hour and 45-minute differences", () => {
    const at = new Date("2026-01-15T10:12:00Z");
    expect(label("Asia/Kolkata", at, "UTC", en)).toBe(
      "3:42 PM local time · 5h 30m ahead",
    );
    expect(label("America/Los_Angeles", at, "Asia/Kolkata", en)).toBe(
      "2:12 AM local time · 13h 30m behind",
    );
    expect(label("Asia/Kathmandu", at, "Asia/Kolkata", en)).toBe(
      "3:57 PM local time · 15m ahead",
    );
  });

  it("leaves out the difference when the clocks match", () => {
    const at = new Date("2026-01-15T14:42:00Z");
    expect(label("Europe/Paris", at, "Europe/Paris", en)).toBe(
      "3:42 PM local time",
    );
    expect(label("Europe/Berlin", at, "Europe/Paris", en)).toBe(
      "3:42 PM local time",
    );
  });

  it("marks a different calendar date in either zone", () => {
    // Los Angeles is still on November 11 when Kolkata reaches the 12th.
    const at = new Date("2026-11-12T00:12:00Z");
    expect(label("Asia/Kolkata", at, "America/Los_Angeles", en)).toBe(
      "5:42 AM tomorrow local time · 13h 30m ahead",
    );
    expect(label("America/Los_Angeles", at, "Asia/Kolkata", en)).toBe(
      "4:12 PM yesterday local time · 13h 30m behind",
    );
  });

  it("names the weekday when the dates are two apart", () => {
    // Kiritimati (UTC+14) is on Friday the 16th while Pago Pago (UTC-11) is
    // still on Wednesday the 14th.
    const at = new Date("2026-01-15T10:30:00Z");
    expect(label("Pacific/Kiritimati", at, "Pacific/Pago_Pago", en)).toBe(
      "12:30 AM Friday local time · 25h ahead",
    );
    expect(label("Pacific/Pago_Pago", at, "Pacific/Kiritimati", en)).toBe(
      "11:30 PM Wednesday local time · 25h behind",
    );
    // The weekday stays in the label's English, whatever the time's locale.
    expect(
      label("Pacific/Kiritimati", at, "Pacific/Pago_Pago", {
        locale: "fr-FR",
      }),
    ).toMatch(/^0?0:30 Friday local time · 25h ahead$/);
  });

  it("changes the day marker at the viewer's midnight", () => {
    expect(
      label(
        "Europe/London",
        new Date("2026-01-15T04:59:00Z"),
        "America/New_York",
        en,
      ),
    ).toBe("4:59 AM tomorrow local time · 5h ahead");
    expect(
      label(
        "Europe/London",
        new Date("2026-01-15T05:00:00Z"),
        "America/New_York",
        en,
      ),
    ).toBe("5:00 AM local time · 5h ahead");
  });

  it("uses the chosen hour cycle", () => {
    expect(
      label("UTC", new Date("2026-01-15T15:42:00Z"), "UTC", {
        ...en,
        hourCycle: "h23",
      }),
    ).toBe("15:42 local time");
  });

  it("shows nothing for an absent or unknown zone", () => {
    const at = new Date("2026-01-15T15:42:00Z");
    for (const zone of [undefined, "", "Mars/Olympus_Mons", "not a zone"])
      expect(localTimeLabel(zone, at, "UTC", en)).toBeUndefined();
    // An unknown viewer zone still shows the time, without a difference.
    expect(label("UTC", at, "Mars/Olympus_Mons", en)).toBe(
      "3:42 PM local time",
    );
  });
});

describe("profileTimeZone", () => {
  it("accepts only zones the runtime knows", () => {
    expect(profileTimeZone("America/Los_Angeles")).toBe("America/Los_Angeles");
    expect(profileTimeZone(42)).toBeUndefined();
    expect(profileTimeZone({})).toBeUndefined();
    expect(profileTimeZone("Nowhere/Special")).toBeUndefined();
  });
});
