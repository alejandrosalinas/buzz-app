import { devicePreference } from "../../features/messages/device-preference";

/** Device-local choice: on a Mac, Option sends Meta in the terminal. Off by default. */
export const optionMetaPreference = devicePreference(
  "buzz-terminal-option-meta.v1",
  "buzz-terminal-option-meta-changed",
);
