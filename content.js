/*
 * Foclóirí — content script.
 *
 * Finds the word under a click with caretPositionFromPoint (no rewriting of
 * the page DOM, unlike Teanglann's own cab.js widget) and shows the entry in
 * a closed-shadow-DOM popup, so neither the page's CSS nor its CSP can
 * interfere. All network traffic goes through the background script.
 *
 * Interaction model:
 *   - Toolbar toggle ON: plain click on ordinary text looks the word up.
 *     Links, buttons and form fields keep working normally.
 *   - Alt+click: looks a word up anywhere, any time — even inside links,
 *     even with the toggle off.
 */

'use strict';

let enabled = false;

browser.runtime.sendMessage({ type: 'getEnabled' }).then(
  (r) => { enabled = Boolean(r && r.enabled); },
  () => {}
);

browser.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'setEnabled') {
    enabled = msg.enabled;
    if (!enabled) closePopup();
  }
});

/* ------------------------------------------------------------------ *
 * Word under the cursor
 * ------------------------------------------------------------------ */

/* Letters (incl. á é í ó ú), combining marks, apostrophes (b'fhéidir, d'ith)
   and hyphens (t-athair, n-éan). */
const WORD_CHAR = /[\p{L}\p{M}'’-]/u;

function wordAtPoint(x, y) {
  const pos = document.caretPositionFromPoint(x, y);
  if (!pos) return null;
  const node = pos.offsetNode;
  if (!node || node.nodeType !== Node.TEXT_NODE) return null;

  const text = node.data;
  let start = pos.offset;
  let end = pos.offset;
  while (start > 0 && WORD_CHAR.test(text[start - 1])) start--;
  while (end < text.length && WORD_CHAR.test(text[end])) end++;

  let word = text.slice(start, end);
  word = word.replace(/^['’-]+/, '').replace(/['’-]+$/, '');
  if (!word || word.length > 60 || !/\p{L}/u.test(word)) return null;
  return word;
}

function isInteractive(el) {
  return Boolean(el.closest('a, button, input, textarea, select, label, summary, [contenteditable=""], [contenteditable="true"], [role="button"], [role="link"]'));
}

document.addEventListener(
  'click',
  (event) => {
    if (popupHost && event.composedPath().includes(popupHost)) return;
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey) return;

    /* Drag-selecting text fires a click on mouseup — don't hijack it. */
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) return;

    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;

    const wanted = event.altKey || (enabled && !isInteractive(target));
    if (!wanted) {
      if (popupHost) closePopup();
      return;
    }

    const word = wordAtPoint(event.clientX, event.clientY);
    if (!word) {
      if (popupHost) closePopup();
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    openPopup(event.clientX, event.clientY);
    lookupInto(word);
  },
  true
);

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closePopup();
});

/* ------------------------------------------------------------------ *
 * Popup
 * ------------------------------------------------------------------ */

const POPUP_CSS = `
  :host { all: initial; }
  .box {
    position: fixed;
    z-index: 2147483647;
    width: 340px;
    max-width: calc(100vw - 24px);
    box-sizing: border-box;
    background: #fffdf7;
    color: #1c1c1c;
    border: 1px solid #b9b3a4;
    border-radius: 8px;
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.28);
    font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  @media (prefers-color-scheme: dark) {
    .box { background: #26241f; color: #e8e4da; border-color: #55503f; }
    .head { background: #322f27; border-color: #55503f; }
    .foot { background: #322f27; border-color: #55503f; }
    a { color: #8ab4f8; }
  }
  .head {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 8px 12px;
    background: #f3eee1;
    border-bottom: 1px solid #ddd5c2;
  }
  .head .word { font-weight: 700; font-size: 16px; }
  .head .audio { display: inline-flex; gap: 4px; }
  .head .audio button {
    cursor: pointer;
    font: 700 10px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    color: inherit;
    background: none;
    border: 1px solid currentColor;
    border-radius: 9px;
    padding: 0 6px;
    opacity: 0.65;
  }
  .head .audio button:hover:not(:disabled) { opacity: 1; }
  .head .audio button:disabled { opacity: 0.2; cursor: default; }
  .head .layout {
    margin-left: auto;
    cursor: pointer;
    font: 700 10px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    color: inherit;
    background: none;
    border: 1px solid currentColor;
    border-radius: 9px;
    padding: 0 6px;
    opacity: 0.65;
  }
  .head .layout:hover { opacity: 1; }
  .head .layout[aria-pressed="true"] {
    opacity: 1;
    color: #fffdf7;
    background: #7a1f1f;
    border-color: #7a1f1f;
  }
  @media (prefers-color-scheme: dark) {
    .head .layout[aria-pressed="true"] { color: #26241f; background: #e8a0a0; border-color: #e8a0a0; }
  }
  .head .close {
    cursor: pointer;
    border: none;
    background: none;
    font: inherit;
    font-size: 18px;
    line-height: 1;
    color: inherit;
    opacity: 0.6;
    padding: 0 2px;
  }
  .head .close:hover { opacity: 1; }
  .body { padding: 10px 12px; overflow-y: auto; max-height: 320px; }
  .note { font-style: italic; opacity: 0.75; margin-bottom: 8px; }
  .status { opacity: 0.75; font-style: italic; }
  .foot {
    padding: 6px 12px;
    background: #f3eee1;
    border-top: 1px solid #ddd5c2;
    font-size: 12px;
    display: flex;
    justify-content: space-between;
    gap: 8px;
  }
  a { color: #336699; text-decoration: none; }
  a:hover { text-decoration: underline; }
  hr.entrysep { border: none; border-top: 1px dashed #b9b3a4; margin: 10px 0; }

  /* Approximation of teanglann.ie's own entry styling (span classes kept
     verbatim from their markup). */
  .title { font-weight: 700; font-size: 15px; color: #7a1f1f; }
  @media (prefers-color-scheme: dark) { .title { color: #e8a0a0; } }
  .g { font-style: italic; opacity: 0.7; }
  .b, .s { font-weight: 600; }
  .r { font-weight: 400; }
  .l { font-style: italic; }
  .x { vertical-align: super; font-size: 0.75em; }
  .tip { border-bottom: 1px dotted currentColor; cursor: help; }
  .clickable { cursor: pointer; }
  .clickable:hover { text-decoration: underline; }
  ul.sugg { margin: 4px 0 0; padding-left: 18px; }
  ul.sugg li { margin: 2px 0; }

  /* "Leagan amach simplí" — the same idea as teanglann.ie's blocky layout:
     each example and numbered sense starts on its own line, which is much
     easier to scan in a narrow popup. */
  .box.blocky .example {
    display: block;
    margin: 4px 0 4px 10px;
    padding: 4px 6px;
    background: #f4f0e5;
    border-left: 3px solid #ddd5c2;
  }
  .box.blocky .entry > .sensenum::before {
    content: "";
    display: block;
    margin-top: 0.6em;
    margin-bottom: 2px;
  }
  @media (prefers-color-scheme: dark) {
    .box.blocky .example { background: #2f2c25; border-left-color: #55503f; }
  }
`;

let popupHost = null;
let popupShadow = null;
let popupHeadword = '';
let lookupSeq = 0;

/* "Leagan amach simplí", on by default — teanglann.ie's own blocky layout.
   The preference is remembered across pages with storage.local. */
let simpleLayout = true;
browser.storage.local.get('simpleLayout').then(
  (r) => {
    if (r && typeof r.simpleLayout === 'boolean') {
      simpleLayout = r.simpleLayout;
      if (popupShadow) applySimpleLayout(popupShadow.querySelector('.box'));
    }
  },
  () => {}
);

function applySimpleLayout(box) {
  if (!box) return;
  box.classList.toggle('blocky', simpleLayout);
  const button = box.querySelector('.head .layout');
  if (button) button.setAttribute('aria-pressed', String(simpleLayout));
}

/* The popup is position:fixed, so scrolling would leave it hanging over the
   wrong text — close it instead (scrolling *inside* the popup is fine). */
function onViewportChange(event) {
  if (event.type === 'scroll' && popupHost && event.composedPath().includes(popupHost)) return;
  closePopup();
}

function closePopup() {
  if (popupHost) {
    popupHost.remove();
    popupHost = null;
    popupShadow = null;
    window.removeEventListener('scroll', onViewportChange, true);
    window.removeEventListener('resize', onViewportChange);
  }
}

function openPopup(x, y) {
  closePopup();
  popupHost = document.createElement('focloiri-popup');
  popupShadow = popupHost.attachShadow({ mode: 'closed' });

  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(POPUP_CSS);
    popupShadow.adoptedStyleSheets = [sheet];
  } catch (e) {
    const style = document.createElement('style');
    style.textContent = POPUP_CSS;
    popupShadow.appendChild(style);
  }

  const box = document.createElement('div');
  box.className = 'box';
  box.innerHTML = `
    <div class="head">
      <span class="word"></span>
      <span class="audio" hidden>
        <button data-dialect="C" title="Canúint Chonnacht">C</button>
        <button data-dialect="M" title="Canúint na Mumhan">M</button>
        <button data-dialect="U" title="Canúint Uladh">U</button>
      </span>
      <button class="layout" type="button" title="Leagan amach simplí" aria-pressed="true">Simplí</button>
      <button class="close" type="button" title="Dún">×</button>
    </div>
    <div class="body"><span class="status">Ag cuardach…</span></div>
    <div class="foot">
      <span class="dict">Foclóir Gaeilge–Béarla (Ó Dónaill)</span>
      <a class="src" href="https://www.teanglann.ie/" target="_blank" rel="noopener noreferrer">teanglann.ie »</a>
    </div>`;
  popupShadow.appendChild(box);
  applySimpleLayout(box);

  box.querySelector('.close').addEventListener('click', closePopup);
  box.addEventListener('click', (event) => {
    /* Layout toggle — "Leagan amach simplí" (blocky entry layout). */
    if (event.target.closest('.head .layout')) {
      simpleLayout = !simpleLayout;
      applySimpleLayout(box);
      browser.storage.local.set({ simpleLayout }).catch(() => {});
      return;
    }

    /* Pronunciation buttons — audio is played by the background page. */
    const canButton = event.target.closest('.audio button');
    if (canButton) {
      browser.runtime
        .sendMessage({ type: 'playAudio', word: popupHeadword, dialect: canButton.dataset.dialect })
        .then((r) => {
          if (!r || !r.ok) {
            canButton.disabled = true;
            canButton.title = 'Níl fuaim ar fáil';
          }
        })
        .catch(() => {});
      return;
    }

    /* Suggestion links ("focail chosúla") re-run the lookup in place. */
    const suggestion = event.target.closest('ul.sugg a');
    if (suggestion) {
      event.preventDefault();
      lookupInto(suggestion.textContent.trim());
      return;
    }

    /* Real links inside an entry: Teanglann entry links re-run the lookup;
       anything else opens in a new tab — never navigate the host page.
       Footer links keep their own target="_blank". */
    const anchor = event.target.closest('a[href]');
    if (anchor && !anchor.closest('.foot')) {
      event.preventDefault();
      const entry = anchor.href.match(/teanglann\.ie\/ga\/(?:fgb|fb|eid|_search)\/([^/?#]+)/);
      if (entry) lookupInto(decodeURIComponent(entry[1]));
      else window.open(anchor.href, '_blank', 'noopener');
      return;
    }

    /* Teanglann's cross-reference spans (class="… clickable"). */
    const clickable = event.target.closest('.clickable');
    if (!clickable) return;
    event.preventDefault();
    const word = clickable.textContent.replace(/^[\s~,.;:]+|[\s~,.;:]+$/g, '');
    if (word) lookupInto(word.split(/\s+/)[0]);
  });

  window.addEventListener('scroll', onViewportChange, { capture: true, passive: true });
  window.addEventListener('resize', onViewportChange);

  const margin = 12;
  const width = 340;
  let left = x - width / 2;
  left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));
  box.style.left = `${left}px`;
  box.style.top = `${Math.min(y + 16, window.innerHeight - 120)}px`;

  document.documentElement.appendChild(popupHost);

  /* If the box runs off the bottom of the viewport, flip it above the click. */
  requestAnimationFrame(() => {
    if (!popupHost) return;
    const rect = box.getBoundingClientRect();
    if (rect.bottom > window.innerHeight - margin) {
      box.style.top = `${Math.max(margin, y - rect.height - 10)}px`;
    }
  });
}

async function lookupInto(word) {
  if (!popupShadow) return;
  const seq = ++lookupSeq;
  const box = popupShadow.querySelector('.box');
  const head = box.querySelector('.head .word');
  const body = box.querySelector('.body');
  const src = box.querySelector('.foot .src');
  const audio = box.querySelector('.head .audio');

  head.textContent = word;
  body.innerHTML = '<span class="status">Ag cuardach…</span>';
  audio.hidden = true;

  const result = await browser.runtime.sendMessage({ type: 'lookup', word }).catch(() => null);
  if (seq !== lookupSeq || !popupShadow) return;

  if (!result || result.status === 'error') {
    body.innerHTML = '<span class="status">Theip ar an gcuardach — seiceáil do cheangal idirlín.</span>';
    return;
  }

  src.href = result.sourceUrl || `https://www.teanglann.ie/ga/_search/${encodeURIComponent(word)}`;

  if (result.status === 'entry') {
    let html = '';
    if (result.note) {
      head.textContent = result.note.formOf;
      html += `<div class="note"><em>${escapeHtml(result.note.original)}</em> — foirm de <strong>${escapeHtml(result.note.formOf)}</strong></div>`;
    }
    body.innerHTML = html + result.html;
    body.scrollTop = 0;
    popupHeadword = result.headword || head.textContent;
    audio.hidden = false;
    for (const b of audio.querySelectorAll('button')) {
      b.disabled = false;
      b.title = `Canúint ${{ C: 'Chonnacht', M: 'na Mumhan', U: 'Uladh' }[b.dataset.dialect]}`;
    }
  } else if (result.status === 'suggestions') {
    body.innerHTML =
      '<span class="status">Níor aimsíodh an focal. Focail chosúla:</span><ul class="sugg">' +
      result.suggestions.map((s) => `<li><a href="#">${escapeHtml(s)}</a></li>`).join('') +
      '</ul>';
  } else {
    body.innerHTML = '<span class="status">Níor aimsíodh aon torthaí.</span>';
  }
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
