import { expect } from "@playwright/test";

// Hold real focus outside reading surfaces while a journey establishes unread
// state. Blur the target itself: the sidebar may still be inert while the search
// palette closes, so redirecting focus to a sidebar button is not reliable.
export async function holdReadingFocus(page) {
  await page.addInitScript(() => {
    const hold = ({ target }) => {
      if (
        target instanceof HTMLElement &&
        (target.closest("[data-channel-timeline], [data-reading-surface]") ||
          target.matches(
            '[role="textbox"][aria-label^="Message #"], [role="tab"][data-tab-value^="thread:"]',
          ))
      )
        target.blur();
    };
    document.addEventListener("focusin", hold);
    window.fixtureReleaseReadingFocus = () =>
      document.removeEventListener("focusin", hold);
  });
}

export async function releaseReadingFocus(page) {
  await page.evaluate(() => window.fixtureReleaseReadingFocus());
}

// Observe the real durable result, never seed state or call an engine test hook.
export async function readJournal(page) {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open("buzz-read-state-v1", 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction("partitions", "readonly");
          const read = tx.objectStore("partitions").getAll();
          read.onsuccess = () => resolve(read.result[0]);
          read.onerror = () => reject(read.error);
          tx.oncomplete = () => db.close();
        };
      }),
  );
}

// Read everything through Mark all as read, so an ordinary thread opening
// starts at its latest reply rather than at a New messages line.
export async function markAllRead(page) {
  await page.keyboard.press("Shift+Escape");
  await page
    .getByRole("button", { name: "Mark all as read", exact: true })
    .click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
}

// An unread thread opening pages older to find its first unread reply. Release
// the older pages the fixture holds for it until `ready` passes.
export async function releasing(app, ready) {
  await expect(async () => {
    for (const receipt of app.pending) receipt.release();
    await ready();
  }).toPass();
}
