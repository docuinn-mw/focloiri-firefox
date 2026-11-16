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
- The **Simplí** button switches the entry between the compact layout and a
  simple, block-style layout (the same idea as teanglann.ie's *Leagan amach
  simplí*) in which each example and numbered sense starts on its own line.
  It is on by default and the choice is remembered across pages.
- Inflected forms are resolved by Teanglann's own search: *bhfanacht* resolves
  to *fanacht*, *thithe* to *teach*, and so on (shown as "foirm de …"). When
  nothing matches, the popup lists Teanglann's "focail chosúla" suggestions.

## Installation

For development:

1. Open `about:debugging#/runtime/this-firefox` in Firefox.
2. Click **Load Temporary Add-on…** and pick `manifest.json` in this
   directory.

Temporary add-ons are removed when Firefox restarts. For a personal permanent
install, sign the extension for self-distribution:

```sh
web-ext sign --channel unlisted --api-key <JWT issuer> --api-secret <JWT secret>
```

then install the resulting `.xpi` via `about:addons` → gear menu →
**Install Add-on From File…**.

## Publishing an update

Foclóirí is listed on AMO with the ID `focloiri@docuinn.github.io`. To publish
a new version:

1. Bump `version` in `manifest.json`.
2. Run `web-ext lint --source-dir .` and fix any errors.
3. Upload the new version at
   [addons.mozilla.org/developers/addons](https://addons.mozilla.org/developers/addons)
   → **Foclóirí** → **New Version**. (You can also run
   `web-ext sign --channel listed` with your API credentials; see below.)
4. Add release notes, submit, and wait for review. The current version stays
   live until the new one is approved.

To build the upload package:

```sh
web-ext build --source-dir . --overwrite-dest
```

The `.zip` is written to `web-ext-artifacts/`. `.web-ext-config.mjs` keeps the
old root `focloiri.zip` out of the package.

For publishing from the command line, create API credentials at
[addons.mozilla.org/developers/addon/api/key](https://addons.mozilla.org/developers/addon/api/key/)
and set them as environment variables so they don't end up in your shell
history:

```sh
export WEB_EXT_API_KEY='<JWT issuer>'
export WEB_EXT_API_SECRET='<JWT secret>'
web-ext sign --channel listed --approval-timeout 0
```

`--approval-timeout 0` submits the version and exits instead of waiting for
review; watch the Developer Hub or your email for the review result.

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
- The **Simplí** layout is a small local copy of teanglann.ie's
  `blocky` styles. Teanglann implements its layout picker with a CSS class, so
  the extension does the same rather than making extra requests; the setting
  is persisted with `storage.local`.
- Pronunciation recordings live at `/Can{C,M,U}/<headword>.mp3` (404 when no
  recording exists). They are fetched and played by the background page, so
  the host page's CSP cannot block them.

## License

[GPL-3.0](LICENSE). The license covers this extension's code only — the
dictionary entries and pronunciation recordings it displays are
© Foras na Gaeilge, served live from teanglann.ie.
