// Runs in the page: waits until no finite animation is running on the element
// or, with `subtree`, on its descendants; or with `report`, names each one.
async function finiteAnimations(element, { subtree, report }) {
  const running = () =>
    element
      .getAnimations({ subtree })
      .filter(
        (animation) =>
          animation.playState === "running" &&
          animation.effect?.getComputedTiming().endTime !== Infinity,
      );
  if (report) {
    // A CSS animation or transition has a name; Motion's animations are
    // named by the properties they animate.
    const timing = new Set(["offset", "computedOffset", "easing", "composite"]);
    return running().map(({ animationName, transitionProperty, effect }) => {
      const properties = new Set(effect.getKeyframes().flatMap(Object.keys));
      const name =
        animationName ??
        transitionProperty ??
        [...properties.difference(timing)].join(", ");
      const pseudo = effect.pseudoElement ? `${effect.pseudoElement} of ` : "";
      return `${name} on ${pseudo}${effect.target.cloneNode(false).outerHTML}`;
    });
  }
  while (running().length)
    await Promise.allSettled(running().map((animation) => animation.finished));
}

// Waits until no finite animation is running on the target element or, with
// `subtree`, on its descendants. Motion cancels an animation it replaces, and
// a cancelled animation's `finished` promise rejects with AbortError, so
// awaiting every `finished` with Promise.all fails on such an interruption.
// The replacement keeps running, so the wait also covers animations that start
// while it runs. Infinite animations, such as spinners, never finish and are
// ignored. If animations are still running after 10 s, for example because
// something keeps starting them, the wait fails and names each one, instead of
// holding until the test's timeout. Node keeps that deadline: Playwright's
// clock can pause the page's own timers. `target` is a Locator or an element
// handle.
export async function animationsSettled(target, { subtree = false } = {}) {
  const settled = target.evaluate(finiteAnimations, { subtree });
  // After the deadline, a rejection as the page closes must not go unhandled.
  settled.catch(() => {});
  let timer;
  const expired = new Promise((resolve) => {
    timer = setTimeout(resolve, 10_000, true);
  });
  const late = await Promise.race([settled.then(() => false), expired]).finally(
    () => clearTimeout(timer),
  );
  if (!late) return;
  const running = await target.evaluate(finiteAnimations, {
    subtree,
    report: true,
  });
  if (running.length)
    throw new Error(
      `Animations still running after 10 s: ${running.join("; ")}`,
    );
}
