# File viewer

Reads the PDFs, Markdown, code, text and CSV files shared in a conversation, beside the thread.

## Getting started

1. Turn it on in **Settings → Plugins**.
2. Choose a shared file's card to open it beside the conversation. The card's download button still saves the file.
3. Page through a PDF with ‹ and › or the arrow keys, and zoom with **−**, **+** or **Fit to width**. Choose **Copy text** to copy a file's text.
4. In a Markdown file with three or more headings, choose **Outline** to go to a section.

---

Only files shared in the current community open. Text files open up to 20 MB and PDFs up to 100 MB, laid out to the first 1,000 pages. Spreadsheets in CSV or TSV show the first 5,000 rows and 200 columns, up to 50,000 cells.

Markdown, code and text files of any length read in parts: the parts near your place are on the page, and the outline and `#` links go to a section in any part. Code is highlighted, with line numbers. The header shows when the file was shared, with a Markdown file's reading time and word count, or a code or text file's lines. Markdown follows the same rules as Notes: no raw HTML, and links open as they do in messages. Images shared in the current community are drawn; other images show as their alt text. A PDF's **Copy text** reads the text from its pages when pressed, and says when a scanned PDF has none.

Other plugins can open a shared file in the viewer with the target `buzz-file:?url=<url>&name=<name>&mime=<mime>&time=<seconds>` (all but `url` are optional; `time` is when the file was shared, in Unix seconds). Each part is in the target, so the same file shared in two messages opens in two tabs. The viewer claims file cards and targets at order 100, the band for bundled catch-alls, so any plugin that registers its own renderer or panel for the same files at a lower order takes them over.

PDFs are drawn with [PDF.js](https://mozilla.github.io/pdf.js/), loaded the first time a PDF opens.
