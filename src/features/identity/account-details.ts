/**
 * Builderlab's account setup (name, date of birth, country), as the web
 * console's `/account/setup` asks for it: the same fields, rules and wire
 * names (ext-builderbot-ui `accountDetailsValidation.ts`, `dateOfBirth.ts`,
 * `countries.ts`), so desktop and web refuse the same input before kgoose does.
 */

/** kgoose `v1/identity/save-account-details`'s body. */
export type AccountDetails = Readonly<{
  first_name: string;
  last_name: string;
  /** ISO `YYYY-MM-DD`. */
  date_of_birth: string;
  /** ISO 3166-1 alpha-2. */
  country_code: string;
}>;

/** Keyed by wire name, so kgoose's `invalid_fields` map straight onto the form. */
export type AccountDetailsField = keyof AccountDetails;
export type AccountDetailsErrors = Partial<Record<AccountDetailsField, string>>;

export type AccountDetailsInput = Readonly<{
  firstName: string;
  lastName: string;
  /** The date field's `YYYY-MM-DD`, or "" while incomplete. */
  dateOfBirth: string;
  countryCode: string;
}>;

/** kgoose refused fields it names; the form shows each under its field. */
export class InvalidAccountDetails extends Error {
  constructor(readonly fields: readonly string[]) {
    super("Check your details and try again.");
    this.name = "InvalidAccountDetails";
  }
}

/* ISO 3166-1 alpha-2. Screening decides eligibility server-side, so every code is listed. */
/* biome-ignore format: one row per letter keeps 249 codes reviewable */
const COUNTRY_CODES = [
  "AD", "AE", "AF", "AG", "AI", "AL", "AM", "AO", "AQ", "AR", "AS", "AT", "AU", "AW", "AX", "AZ",
  "BA", "BB", "BD", "BE", "BF", "BG", "BH", "BI", "BJ", "BL", "BM", "BN", "BO", "BQ", "BR", "BS", "BT", "BV", "BW", "BY", "BZ",
  "CA", "CC", "CD", "CF", "CG", "CH", "CI", "CK", "CL", "CM", "CN", "CO", "CR", "CU", "CV", "CW", "CX", "CY", "CZ",
  "DE", "DJ", "DK", "DM", "DO", "DZ",
  "EC", "EE", "EG", "EH", "ER", "ES", "ET",
  "FI", "FJ", "FK", "FM", "FO", "FR",
  "GA", "GB", "GD", "GE", "GF", "GG", "GH", "GI", "GL", "GM", "GN", "GP", "GQ", "GR", "GS", "GT", "GU", "GW", "GY",
  "HK", "HM", "HN", "HR", "HT", "HU",
  "ID", "IE", "IL", "IM", "IN", "IO", "IQ", "IR", "IS", "IT",
  "JE", "JM", "JO", "JP",
  "KE", "KG", "KH", "KI", "KM", "KN", "KP", "KR", "KW", "KY", "KZ",
  "LA", "LB", "LC", "LI", "LK", "LR", "LS", "LT", "LU", "LV", "LY",
  "MA", "MC", "MD", "ME", "MF", "MG", "MH", "MK", "ML", "MM", "MN", "MO", "MP", "MQ", "MR", "MS", "MT", "MU", "MV", "MW", "MX", "MY", "MZ",
  "NA", "NC", "NE", "NF", "NG", "NI", "NL", "NO", "NP", "NR", "NU", "NZ",
  "OM",
  "PA", "PE", "PF", "PG", "PH", "PK", "PL", "PM", "PN", "PR", "PS", "PT", "PW", "PY",
  "QA",
  "RE", "RO", "RS", "RU", "RW",
  "SA", "SB", "SC", "SD", "SE", "SG", "SH", "SI", "SJ", "SK", "SL", "SM", "SN", "SO", "SR", "SS", "ST", "SV", "SX", "SY", "SZ",
  "TC", "TD", "TF", "TG", "TH", "TJ", "TK", "TL", "TM", "TN", "TO", "TR", "TT", "TV", "TW", "TZ",
  "UA", "UG", "UM", "US", "UY", "UZ",
  "VA", "VC", "VE", "VG", "VI", "VN", "VU",
  "WF", "WS",
  "YE", "YT",
  "ZA", "ZM", "ZW",
] as const;

const isCountryCode = (value: string) =>
  (COUNTRY_CODES as readonly string[]).includes(value);

const regionOf = (language: string) => {
  try {
    return new Intl.Locale(language).region;
  } catch {
    return undefined;
  }
};

/**
 * Every country by name, with the one the system languages suggest (GB for
 * en-GB) pinned above the full list, which still includes it.
 */
export function countryGroups(
  languages: readonly string[] = globalThis.navigator?.languages ?? [],
) {
  const names = new Intl.DisplayNames(undefined, { type: "region" });
  const options = COUNTRY_CODES.map((code) => ({
    value: code,
    label: names.of(code) ?? code,
  })).sort((first, second) => first.label.localeCompare(second.label));
  const region = languages
    .map(regionOf)
    .find((code) => code && isCountryCode(code));
  const suggested = options.find((option) => option.value === region);
  return suggested
    ? [
        { label: "Suggested", options: [suggested] },
        { label: "All countries and regions", options, separator: true },
      ]
    : [{ label: "Countries and regions", options }];
}

const OLDEST_AGE_YEARS = 120;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const pad = (value: number) => String(value).padStart(2, "0");
const local = (date: Date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

/** The date field's range: no more than 120 years ago, up to yesterday. */
export function birthDateBounds(today = new Date()) {
  const yesterday = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate() - 1,
  );
  return {
    min: `${today.getFullYear() - OLDEST_AGE_YEARS}-01-01`,
    max: local(yesterday),
  };
}

/** `value` when it is a real date in that range, otherwise null. */
export function isoDateOfBirth(value: string, today = new Date()) {
  const match = ISO_DATE.exec(value);
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number) as [
    number,
    number,
    number,
  ];
  const date = new Date(Date.UTC(year, month - 1, day));
  const real = date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  const { min, max } = birthDateBounds(today);
  return real && value >= min && value <= max ? value : null;
}

export const NAME_MAX_LENGTH = 191;

/* Flags are regional indicator pairs, keycaps a digit plus U+FE0F U+20E3, and skin tones modifiers, so none counts as pictographic. */
const EMOJI =
  /\p{Extended_Pictographic}|\p{Regional_Indicator}|\p{Emoji_Modifier}|\u{FE0F}|\u{20E3}/u;
const CONTROL = /\p{Cc}/u;
const LETTER_MARK_OR_NUMBER = /[\p{L}\p{M}\p{N}]/u;
/* Carian, Old Italic, Miscellaneous Symbols, Linear A and Mathematical Alphanumeric Symbols, which screening can't match. */
const UNSCREENABLE: readonly (readonly [number, number])[] = [
  [0x102a0, 0x102df],
  [0x10300, 0x1032f],
  [0x2600, 0x26ff],
  [0x10600, 0x1077f],
  [0x1d400, 0x1d7ff],
];

const NAME_LABELS = { first_name: "first name", last_name: "last name" };

function nameProblem(field: keyof typeof NAME_LABELS, name: string) {
  if (!name) return `Enter your ${NAME_LABELS[field]}.`;
  if (name.length > NAME_MAX_LENGTH)
    return `Use ${NAME_MAX_LENGTH} characters or fewer.`;
  const unscreenable = [...name].some((character) => {
    const point = character.codePointAt(0) ?? 0;
    return UNSCREENABLE.some(
      ([first, last]) => point >= first && point <= last,
    );
  });
  if (EMOJI.test(name) || CONTROL.test(name) || unscreenable)
    return "Remove emoji, symbols and special characters.";
  if (name.split(/\s+/u).some((word) => !LETTER_MARK_OR_NUMBER.test(word)))
    return "Every word needs at least one letter or number.";
  return undefined;
}

/** The request, or what to fix under each field: the rules kgoose and screening enforce. */
export function validateAccountDetails(
  input: AccountDetailsInput,
  today = new Date(),
):
  | { details: AccountDetails; errors?: undefined }
  | { details?: undefined; errors: AccountDetailsErrors } {
  const first_name = input.firstName.trim();
  const last_name = input.lastName.trim();
  const date_of_birth = isoDateOfBirth(input.dateOfBirth, today);
  const errors: AccountDetailsErrors = {};
  const first = nameProblem("first_name", first_name);
  const last = nameProblem("last_name", last_name);
  if (first) errors.first_name = first;
  if (last) errors.last_name = last;
  if (!date_of_birth)
    errors.date_of_birth = "Choose a real date of birth in the past.";
  if (!isCountryCode(input.countryCode))
    errors.country_code = "Choose your country or region.";
  if (Object.keys(errors).length > 0 || !date_of_birth) return { errors };
  return {
    details: {
      first_name,
      last_name,
      date_of_birth,
      country_code: input.countryCode,
    },
  };
}

/** kgoose's word for a field it refused. */
export function invalidFieldMessage(field: string) {
  if (field === "date_of_birth") return "Check your date of birth.";
  if (field === "country_code") return "Check your country or region.";
  if (field === "first_name") return "Check your first name.";
  if (field === "last_name") return "Check your last name.";
  return undefined;
}
