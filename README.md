# Story to Rich Text

A small, private-by-design web page that turns a story typed with inline HTML
(`<b>`, `<i>`, `<center>`, …) but no paragraph tags into clean rich text,
without losing your line breaks or blank-line paragraphs.

Use [Story to Rich Text](https://brianmarkowitz.github.io/story-to-rich-text/),
or open `docs/index.html` in a browser.

## What it does

- A single Enter becomes a line break. A blank line starts a new paragraph.
  This holds even when a newline falls inside `<b>…</b>` or other formatting.
- Existing HTML blocks (`<p>`, headings, `<blockquote>`, lists, `<br>`) are
  respected. Indentation between them doesn't create extra gaps.
- Supported formatting: bold, italic, underline, strikethrough, subscript,
  superscript, code, headings, centring and `text-align`, lists, quotes and
  `http(s)` links.
- Options: format escaped tags (`&lt;b&gt;`) or show all tags as plain text;
  keep or join single line breaks; paragraph spacing (spaced, book-style
  indent, compact); keep extra blank lines as scene breaks (each blank line
  beyond the first is kept, up to 50, in the preview and every export).
- **Copy rich text** puts both `text/html` and `text/plain` on the clipboard
  so Word and Google Docs keep the breaks and formatting. If the browser
  refuses, the page says so, and **Select preview** lets you copy by hand.
- Downloads: a real `.rtf` (Unicode, paragraph and inline formatting), a
  standalone sanitized `.html` and plain `.txt`. You can also print or save
  as PDF.

## Privacy

- Your writing stays in the open tab. There are no uploads, no accounts, no
  saving (no localStorage, cookies or autosave), no analytics and no AI
  processing of your text. Copy or download your result before closing.
- The page loads nothing from the network: no external fonts, scripts or
  images. Its Content-Security-Policy (`default-src 'none'`,
  `connect-src 'none'`, with hashes for its own inline script and style)
  blocks outgoing requests even if something tried to make one.
- Pasted HTML is parsed in an inert `<template>` and read from there. A new
  DOM is built from an allowlist, so the raw input is never attached to the
  page. Scripts, styles, frames, embeds, SVG/MathML, forms, media, images,
  meta/link/base and templates are dropped with their contents. Event
  attributes, ids, classes and arbitrary styles are dropped too. Only
  validated alignment and basic text formatting are kept. Links must be
  absolute `http://` or `https://` URLs without credentials. Exported HTML
  comes from the same clean model and has its own restrictive CSP.
- The browser's spelling, autocorrect and writing suggestions are turned off
  in the source box.
- "Save this tool for offline use" downloads this page's own static file,
  even after the file has been renamed, never the page with your draft in it.

## Development

There's no build step and no runtime dependency. Everything is in
`docs/index.html`, and `docs/.nojekyll` lets GitHub Pages serve it as is.

```bash
node tests/run-tests.mjs      # 51 browser tests (Playwright + Chromium, offline)
node tools/update-csp.mjs     # re-hash the CSP after editing the inline <script> or <style>
```

The tests use an already-installed Playwright, either local or global
(`npm root -g`), with its Chromium. They use only synthetic text. On macOS
they also open the generated RTF with `textutil` to confirm that a real RTF
reader sees the right text, centring, bold and italic.

## Limitations

- Tables, definition lists and other uncommon blocks become plain
  paragraphs. Fonts, colours and sizes are deliberately dropped.
- Formatting inside `<pre>` is reduced to its text.
- Pasting into rich editors depends on the editor. Word and Google Docs read
  the HTML clipboard format, and the RTF download is the fallback.
- When pasted HTML contains `style="…"` attributes, Chrome logs a console
  notice that the CSP refused to apply them. That's the policy working as
  intended. Alignment is read safely from the attribute text.

## Credits

The code was developed and reviewed with AI assistance. The app itself uses
no AI when it converts text.
