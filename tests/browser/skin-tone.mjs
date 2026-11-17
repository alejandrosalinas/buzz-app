// Until a default skin tone is saved, the first pick of an emoji that has
// tones opens the tone menu instead of inserting it. Journeys that pick such
// an emoji for another purpose start with the default tone already chosen.
export const chooseDefaultSkinTone = (page) =>
  page.addInitScript(() => {
    if (localStorage.getItem("emoji-mart.skin") === null)
      localStorage.setItem("emoji-mart.skin", "1");
  });
