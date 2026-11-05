import { autocorrectSetting } from "../features/messages/autocorrect-preference";
import { followUpBehaviorSetting } from "../features/messages/follow-up-preference";
import { rememberAgentsSetting } from "../features/messages/mention-preferences";
import { threadPlacementSetting } from "../features/messages/thread-preferences";
import { unreadFirstSetting } from "../features/search/unread-first-preference";
import { createDeviceSettings } from "../shared/device-settings";
import type { Appearance } from "../shared/theme/service";
import { appearanceSettings } from "../shared/theme/settings";

// The Buzz settings every agent running here can read and change. Each feature
// owns its definitions; add one here to offer it through the settings tools.
// Settings with no synchronous setter, such as notifications, keep-awake and
// plugins' own, aren't here yet. Keep out secrets, sign-in, grants and consent,
// spending, models and anything destructive.
export const deviceSettings = (appearance: Appearance) =>
  createDeviceSettings([
    ...appearanceSettings(appearance),
    threadPlacementSetting,
    followUpBehaviorSetting,
    autocorrectSetting,
    rememberAgentsSetting,
    unreadFirstSetting,
  ]);
