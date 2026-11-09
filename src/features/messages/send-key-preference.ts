import { devicePreference } from "./device-preference";

/** Device-local choice: ⌘/Ctrl+Enter sends and Enter adds a line. Off by default. */
export const sendKeyPreference = devicePreference(
  "buzz-send-with-mod-enter.v1",
  "buzz-send-with-mod-enter-changed",
);
export const {
  read: sendWithModEnterPreference,
  usePreference: useSendWithModEnterPreference,
  set: setSendWithModEnterPreference,
} = sendKeyPreference;
