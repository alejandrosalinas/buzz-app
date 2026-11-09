import { devicePreference } from "./device-preference";

/** Device-local choice: plain Up edits from an empty composer. Off by default. */
export const editKeyPreference = devicePreference(
  "buzz-edit-with-up-arrow.v1",
  "buzz-edit-with-up-arrow-changed",
);
export const {
  read: editWithUpArrowPreference,
  usePreference: useEditWithUpArrowPreference,
  set: setEditWithUpArrowPreference,
} = editKeyPreference;
