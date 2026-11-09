/** Event kinds delivered on the application's channel subscriptions. */
export const CHANNEL_KINDS = [
  9, 40002, 40008, 45001, 45003, 40099, 40100, 40003, 5, 9005, 7, 39000, 39002,
  39005, 20002, 45010, 48100, 48101, 48102, 48103,
];

const CHANNEL_SOURCE_KINDS = new Set([
  ...CHANNEL_KINDS,
  // Channel moderation, workflow definitions, message controls, votes and guidelines.
  9000,
  9001,
  9002,
  9008,
  9022,
  30620,
  40004,
  40005,
  40006,
  40007,
  45002,
  48106,
]);
/** Includes channel-scoped kinds that only explicit watches poll. Global kinds
 * and target-derived commands cannot claim a source just by supplying h. */
export const channelSourceKind = (kind: number) =>
  CHANNEL_SOURCE_KINDS.has(kind);
