import {
  createContext,
  useContext,
  useMemo,
  useState,
  type CSSProperties,
} from "react";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { RobotIcon } from "../../shared/design-system/icons";
import { agentAvatars } from "../../features/agents/avatar-packs";
import { PackedAgentAvatar } from "../../features/agents/PackedAgentAvatar";
import "./sonar.css";

export const sonarDefaults = {
  size: 160,
  avatarSize: 48,
  rings: 6,
  signals: 12,
  period: 8,
  beam: 60,
  palette: "citrus",
  sweepOpacity: 0.16,
  ringOpacity: 0.16,
  dotSize: 6,
  neutralDotSize: 4,
  dotOpacity: 1,
  dotScale: 0.15,
  easeX1: 0.43,
  easeY1: 1,
  easeX2: 0.32,
  easeY2: 2,
  hintOffset: 4,
  hintDuration: 1.2,
};
/** Local design tools can tune the same illustration the app renders. */
export const SonarSettingsContext = createContext({
  large: sonarDefaults,
  small: {
    ...sonarDefaults,
    size: 64,
    avatarSize: 32,
    rings: 4,
    dotSize: 4,
    neutralDotSize: 2,
    hintDuration: 2.4,
  },
  previewPicture: "",
});
const messages = [
  "Watch for customer feedback",
  "Remind me to follow up tomorrow",
  "Tell me when we have a decision",
  "Watch for design approval",
  "Let me know when there’s a reply",
  "Check in every Monday",
  "Watch for changes to the plan",
  "Tell me when someone needs help",
  "Watch for launch updates",
  "Tell me when this PR is approved",
];

export function AttentionSonar({
  picture,
  name,
  size = "small",
  hints = false,
}: {
  picture?: string | undefined;
  name: string;
  size?: "small" | "large";
  hints?: boolean;
}) {
  const tuning = useContext(SonarSettingsContext);
  const settings = tuning[size];
  picture = tuning.previewPicture || picture;
  const [messageDeck] = useState(() => {
    const deck = [...messages];
    for (let index = deck.length - 1; index > 0; index--) {
      const other = Math.floor(Math.random() * (index + 1));
      const left = deck[index];
      const right = deck[other];
      if (left !== undefined && right !== undefined) {
        deck[index] = right;
        deck[other] = left;
      }
    }
    return deck;
  });
  const citrusSlots = Array.from(
    { length: settings.signals },
    (_, slot) => slot,
  ).filter((slot) => slot % 2 === 1);
  const hintCount = Math.min(3, citrusSlots.length);
  const hintSlots = Array.from(
    { length: hintCount },
    (_, index) =>
      citrusSlots[Math.floor((index * citrusSlots.length) / hintCount)],
  ).filter((slot): slot is number => slot !== undefined);
  const slotGap =
    hintSlots.length > 1
      ? Math.min(
          ...hintSlots.map((slot, index) => {
            const next = hintSlots[(index + 1) % hintSlots.length] ?? slot;
            return next > slot ? next - slot : next + settings.signals - slot;
          }),
        ) - 0.7
      : settings.signals;
  const windowPercent =
    Math.min(
      settings.hintDuration / settings.period,
      (slotGap / settings.signals) * 0.9,
    ) * 100;
  const rise = Math.min((0.16 / settings.period) * 100, windowPercent / 4);
  const hold =
    windowPercent - Math.min((0.12 / settings.period) * 100, windowPercent / 4);
  const avatar = picture
    ? agentAvatars.find(
        (item) => item.url === picture || item.preview === picture,
      )
    : undefined;
  return (
    <div
      className="attention-sonar"
      data-size={size}
      aria-hidden="true"
      style={
        {
          inlineSize: settings.size,
          blockSize: settings.size,
          "--sonar-period": `${settings.period}s`,
          "--sonar-avatar-size": `${settings.avatarSize}px`,
          "--sonar-beam": `${360 - settings.beam}deg`,
          "--sonar-sweep-opacity": settings.sweepOpacity,
          "--sonar-ring-opacity": settings.ringOpacity,
          "--sonar-dot-size": `${settings.dotSize}px`,
          "--sonar-neutral-size": `${settings.neutralDotSize}px`,
          "--sonar-dot-opacity": settings.dotOpacity,
          "--sonar-dot-scale": settings.dotScale,
          "--sonar-dot-ease": `cubic-bezier(${settings.easeX1}, ${settings.easeY1}, ${settings.easeX2}, ${settings.easeY2})`,
          "--sonar-hint-offset": `${settings.hintOffset}px`,
          "--sonar-hint-ease": `linear(0, 0.7 ${rise * 0.35}%, 1.16 ${rise * 0.65}%, 0.98 ${rise * 0.85}%, 1 ${rise}%, 1 ${hold}%, 0 ${windowPercent}%, 0)`,
        } as CSSProperties
      }
    >
      {Array.from(
        { length: settings.rings },
        (_, index) => (index / settings.rings) * 50,
      ).map((inset) => (
        <div
          key={inset}
          className="attention-sonar-ring"
          style={{ inset: `${inset}%` }}
        />
      ))}
      <div
        className="attention-sonar-sweep"
        data-accent={settings.palette}
        data-palette={settings.palette}
      />
      {Array.from({ length: settings.signals }, (_, slot) => slot).map(
        (slot) => (
          <SonarSignal
            key={slot}
            slot={slot}
            count={settings.signals}
            period={settings.period}
            hintIndex={hints ? hintSlots.indexOf(slot) : -1}
            hintsPerPass={hintSlots.length}
            messageDeck={messageDeck}
          />
        ),
      )}
      <div className="attention-sonar-agent">
        <span className="attention-sonar-portrait">
          {avatar ? (
            <PackedAgentAvatar avatar={avatar} />
          ) : (
            <Avatar
              src={picture}
              alt=""
              fallback={name}
              fallbackContent={
                <RobotIcon
                  size={16}
                  style={{
                    inlineSize: "var(--space-4)",
                    blockSize: "var(--space-4)",
                  }}
                />
              }
              size="fill"
            />
          )}
        </span>
      </div>
    </div>
  );
}

/** Refresh only this signal while both it and its hint are invisible.
 * Keeping its angular phase lets the sweep continue across the loop seam. */
function SonarSignal({
  slot,
  count,
  period,
  hintIndex,
  hintsPerPass,
  messageDeck,
}: {
  slot: number;
  count: number;
  period: number;
  hintIndex: number;
  hintsPerPass: number;
  messageDeck: readonly string[];
}) {
  const angle = useMemo(
    () => ((slot + 0.15 + Math.random() * 0.7) / count) * Math.PI * 2,
    [slot, count],
  );
  const [signal, setSignal] = useState(() => ({
    radius: 0.28 + Math.random() * 0.15,
    round: 0,
  }));
  const citrus = slot % 2 === 1;
  return (
    <div
      className="attention-sonar-signal"
      data-accent="citrus"
      data-citrus={citrus || undefined}
      style={
        {
          left: `${50 + Math.sin(angle) * signal.radius * 100}%`,
          top: `${50 - Math.cos(angle) * signal.radius * 100}%`,
          "--sonar-delay": `${(angle / (Math.PI * 2)) * period}s`,
        } as CSSProperties
      }
    >
      <span
        className="attention-sonar-dot"
        onAnimationIteration={() =>
          setSignal((previous) => ({
            radius: 0.28 + Math.random() * 0.15,
            round: previous.round + 1,
          }))
        }
      />
      {hintIndex >= 0 && (
        <span className="attention-sonar-hint-anchor">
          <span className="attention-sonar-hint text-caption">
            {
              messageDeck[
                (signal.round * hintsPerPass + hintIndex) % messageDeck.length
              ]
            }
          </span>
        </span>
      )}
    </div>
  );
}
