// The open channel's sidebar row is quiet (`seen:`), so journeys that start in
// a channel read its unread from the engine. Needs `pluginFixtures`.
export function channelUnread(page, channelId) {
  return page.evaluate((channelId) => {
    const { unread } = window.fixtureRelay.snapshot().session;
    const snapshot = unread.snapshot({ kind: "channel", channelId });
    return {
      observedCount: snapshot.observedCount,
      attentionCount: snapshot.attentionCount,
      manual: snapshot.manual,
      threads: unread.activity(channelId).items?.length ?? 0,
    };
  }, channelId);
}
