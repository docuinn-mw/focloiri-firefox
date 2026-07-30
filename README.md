# Foclóirí

A Firefox extension for Irish language learners and readers: click any Irish
word on any website to see its entry from the
[Foclóir Gaeilge–Béarla (Ó Dónaill)](https://www.teanglann.ie/ga/fgb/) on
teanglann.ie in a popup, with pronunciation audio in the three major dialects.

## Usage

- The toolbar button toggles the dictionary on or off for the current tab
  (the badge shows **AR** when on). While on, clicking ordinary text looks the
  word up; links, buttons and form fields keep working normally.
- Alt+click looks a word up anywhere, at any time, even inside links and even
  with the toggle off.
- Inside the popup, cross-references, entry links and suggestion links re-run
  the lookup in place; other links open in a new tab. The **C · M · U**
  buttons play the headword's pronunciation in the Connacht, Munster and
  Ulster dialects (greyed out if no recording exists). `Esc`, the `×` button,
  clicking elsewhere, or scrolling closes the popup.
- Inflected forms are resolved by Teanglann's own search: *bhfanacht* resolves
  to *fanacht*, *thithe* to *teach*, and so on (shown as "foirm de …"). When
  nothing matches, the popup lists Teanglann's "focail chosúla" suggestions.

## Installation

For development:

1. Open `about:debugging#/runtime/this-firefox` in Firefox.
2. Click **Load Temporary Add-on…** and pick `manifest.json` in this
   directory.

Temporary add-ons are removed when Firefox restarts. For a permanent install,
sign the extension as unlisted on
[addons.mozilla.org](https://addons.mozilla.org/developers/):

```sh
npx web-ext sign --channel unlisted --api-key <JWT issuer> --api-secret <JWT secret>
```

then install the resulting `.xpi` via `about:addons` → gear menu →
**Install Add-on From File…**.

## How it works

- `content.js` finds the word under the cursor with
  `document.caretPositionFromPoint`; the page DOM is never rewritten. The
  popup lives in a closed shadow root with constructed stylesheets, so
  neither the page's CSS nor its Content-Security-Policy can interfere.
- `background.js` performs all network requests. Content scripts are subject
  to the page's cross-origin rules, but the background script fetches
  teanglann.ie freely under the host permission in `manifest.json`.
- Lookup chain, all server-side (no Irish morphology in the extension):
  1. `GET /ga/fgb/<word>` — 404 on a miss; on a hit the entries are in
     `.exacts .entry`.
  2. Pages for inflected forms carry a `.know` box ("Seans gur foirm é X de:
     Y »") which is followed to the base form.
  3. `GET /ga/_search/<word>` — redirects straight to the entry when
     unambiguous, otherwise returns `.suggestions` ("focail chosúla"). The
     no-match results page is served with a 404 status and is parsed
     regardless.
- Fetched markup is sanitised before display: scripts and event handlers are
  stripped, only `class`/`title`/`href` attributes are kept, and links are
  absolutised. Results are cached in memory (500 entries). All fetches carry
  an 8-second timeout.
- Pronunciation recordings live at `/Can{C,M,U}/<headword>.mp3` (404 when no
  recording exists). They are fetched and played by the background page, so
  the host page's CSP cannot block them.

## License

[GPL-3.0](LICENSE). The license covers this extension's code only — the
dictionary entries and pronunciation recordings it displays are
© Foras na Gaeilge, served live from teanglann.ie.
