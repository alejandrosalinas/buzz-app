/** Below this grid width (in rem) the category bar and labelled actions do
 * not fit, so the picker drops the bar and shows Add emoji as an icon. */
const SPACIOUS_GRID_REM = 18;

export const spaciousGrid = (gridWidth: number, rootFontSize: number) =>
  gridWidth >= SPACIOUS_GRID_REM * rootFontSize;

export const rootFontSize = (document: Document) =>
  Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
