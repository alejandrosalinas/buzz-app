import { describe, expect, it } from "vitest";
import {
  countryGroups,
  isoDateOfBirth,
  validateAccountDetails,
} from "./account-details";

const today = new Date(2026, 10, 4);
const valid = {
  firstName: "  Ada ",
  lastName: "Lovelace",
  dateOfBirth: "1990-12-10",
  countryCode: "GB",
};

describe("validateAccountDetails", () => {
  it("trims names and returns kgoose's request", () => {
    expect(validateAccountDetails(valid, today)).toEqual({
      details: {
        first_name: "Ada",
        last_name: "Lovelace",
        date_of_birth: "1990-12-10",
        country_code: "GB",
      },
    });
  });

  it("says what to fix under every field the web console would refuse", () => {
    expect(
      validateAccountDetails(
        {
          firstName: "",
          lastName: "Ada 🐝",
          dateOfBirth: "",
          countryCode: "XX",
        },
        today,
      ),
    ).toEqual({
      errors: {
        first_name: "Enter your first name.",
        last_name: "Remove emoji, symbols and special characters.",
        date_of_birth: "Choose a real date of birth in the past.",
        country_code: "Choose your country or region.",
      },
    });
    expect(
      validateAccountDetails({ ...valid, lastName: "Ada -" }, today).errors,
    ).toEqual({ last_name: "Every word needs at least one letter or number." });
    expect(
      validateAccountDetails({ ...valid, firstName: "a".repeat(192) }, today)
        .errors,
    ).toEqual({ first_name: "Use 191 characters or fewer." });
  });
});

describe("isoDateOfBirth", () => {
  it.each([
    ["1990-02-30", null],
    ["2026-11-04", null],
    ["2026-11-03", "2026-11-03"],
    ["1906-01-01", "1906-01-01"],
    ["1905-12-31", null],
    ["90-01-01", null],
  ])("%s → %s", (value, expected) => {
    expect(isoDateOfBirth(value, today)).toBe(expected);
  });
});

describe("countryGroups", () => {
  it("pins the country the system languages suggest above the full list", () => {
    const [suggested, all] = countryGroups(["en-GB"]);
    expect(suggested?.options.map((option) => option.value)).toEqual(["GB"]);
    expect(all?.options).toHaveLength(249);
  });

  it("lists every country once when no language names one", () => {
    const groups = countryGroups(["en"]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.options).toHaveLength(249);
  });
});
