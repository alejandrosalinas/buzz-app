# Link previews

Shows a card below a message for each web page it links to, with the page's site, title, description and image. Clicking a card opens the link.

## Getting started

Paste a link to a web page into a message. Up to three cards show at once; the rest fold behind **Show more previews**. Write a link as `<https://…>` to send it without a card.

Your Buzz reads each linked page itself, so the site sees your IP address, as it would if you opened the link. No cookies are sent, local and private network addresses are refused, and only the page's title, description, site name and image come back. Turn this plugin off to stop reading pages. Desktop only.

---

### For plugin authors

This plugin registers one `registerLinkPreview` renderer at `order: 100`, the catch-all band. To draw your own card for a site, register a link preview at the default order, `0`, that matches its URLs. To keep a site's links without any card, register one that renders nothing.

Every hop goes through `host.readPage` (the `publicPages` grant) and images through `host.requestBytes` (the `publicImages` grant). Both pin public addresses and follow no redirect; the plugin checks each `Location` with `previewable` before asking again. Image `src` values are only ever `blob:` URLs.
