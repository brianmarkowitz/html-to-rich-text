# Text, Unwrapped

[Open Text, Unwrapped](https://brianmarkowitz.github.io/story-to-rich-text/).
Paste any text (notes, letters, posts, chapters), check the preview, then **Copy formatted text** or **Download document**. No HTML knowledge or setup is needed.

## Automatic formatting

- Recognizes ordinary HTML and common escaped formatting codes, including mixed input. Formatting is rebuilt safely; it never executes pasted code.
- Keeps blank-line paragraphs and larger section spacing, even without paragraph tags.
- Uses conservative rules to join clearly hard-wrapped prose. Poems, dialogue, lists and uncertain line breaks are kept. The original pasted text is never rewritten.
- Uses readable paragraph spacing. Appearance is a preference, so book-style indentation and compact spacing remain optional choices.
- **Adjust formatting** is closed by default. Manual choices stay in effect until **Use automatic settings** restores the defaults.

Copy and download controls stay at the bottom of the viewport. Long text scrolls inside the editor and preview. Phones have **Edit text** and **See preview** views instead of two tall, stacked panels. **More ways to save** contains plain-text copying, manual selection, HTML/text downloads, printing and the offline tool.

The document download is a real `.rtf` with Unicode and formatting support. Rich copying provides both HTML and plain text; if the browser refuses, the tool reports that and offers manual selection.

## Privacy and safety

Conversion and detection run entirely on the device, using fixed rules and no AI. Your writing is never uploaded. There are no accounts, cookies, autosave, storage, external scripts, libraries or fonts. Copy or download before closing; the tool does not save drafts.

The published page shows one public **Site visits** badge, a single SVG image from [Hits](https://github.com/silentsoft/hits). It counts every page load, including repeat visits, since Nov 3, 2026, so it is not a count of unique people. Only that fixed image address is requested, without a referrer, and only on `https://brianmarkowitz.github.io/story-to-rich-text/`. It never receives your writing, the page's query or the file name, and it isn't requested again while you type, copy or download. Hits says its counter doesn't use cookies or track IP addresses or user agents ([privacy policy](https://hits.sh/privacy/)). As with any hosted image, the counter service still sees the network request itself. Local, renamed and offline copies never load it, and exports never include it. If the counter is blocked or down, the badge says "Site visits unavailable" and formatting works as usual. Selecting the badge opens the hits.sh statistics page, a separate site with its own analytics.

Untrusted HTML is read in an inert template. A new allowlisted DOM is built rather than attaching the input. Active/resource elements, event handlers and arbitrary styles are removed. Only safe formatting/alignment and absolute HTTP(S) links without credentials survive. Exported HTML has its own restrictive security policy.

The app's Content Security Policy blocks outgoing connections (`connect-src 'none'`) and all other resources, permits only its own script/style by hash, and allows images only from the exact counter badge path. Browser spelling, autocorrect and writing suggestions are off in the source field.

**Save this tool for offline use** captures a blank startup copy before typing. Saving it needs no network request and includes neither the later draft nor its filename. The saved file, `text-unwrapped.html`, works after renaming and reopening offline, with automatic settings and closed menus.

## Development

A single static page, `docs/index.html`, with no build step or runtime dependencies. `docs/.nojekyll` serves it directly on GitHub Pages.

```bash
node tests/run-tests.mjs       # 67 conversion, detection, interface, counter and privacy checks
node tests/http-download.mjs   # HTTP/offline download and blank-copy regression
node tools/update-csp.mjs      # refresh hashes after changing inline script/style
node tools/update-csp.mjs --check
```

Tests use an installed local or global Playwright with Chromium, synthetic text only, and macOS `textutil` when available to read back real RTF. Layout checks include desktop, small phones and landscape, with long text and always-visible actions.

Automatic detection cannot know an author's intention for every line break. It keeps uncertain breaks; optional adjustments remain available. Tables flatten to paragraphs, formatting inside preformatted blocks becomes text, and custom fonts/colours/sizes are omitted. Clipboard appearance also depends on the receiving editor.

The code was developed and reviewed with AI assistance. No AI processes your text when the tool is used.
