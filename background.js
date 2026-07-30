/*
 * Foclóirí — background script.
 *
 * Owns two things:
 *   1. The per-tab on/off toggle (toolbar button + badge).
 *   2. Dictionary lookups against teanglann.ie. Content scripts can't fetch
 *      cross-origin, but the background script can because of the
 *      host permission in manifest.json — CORS does not apply here.
 */

'use strict';

const BASE = 'https://www.teanglann.ie';

/* ------------------------------------------------------------------ *
 * Per-tab toggle
 * ------------------------------------------------------------------ */

const enabledTabs = new Set();

function setBadge(tabId, on) {
  browser.browserAction.setBadgeText({ tabId, text: on ? 'AR' : '' });
  browser.browserAction.setBadgeBackgroundColor({ tabId, color: '#2e7d32' });
}

browser.browserAction.onClicked.addListener((tab) => {
  const on = !enabledTabs.has(tab.id);
  if (on) enabledTabs.add(tab.id);
  else enabledTabs.delete(tab.id);
  setBadge(tab.id, on);
  browser.tabs.sendMessage(tab.id, { type: 'setEnabled', enabled: on }).catch(() => {
    /* No content script in this tab (about:, addons.mozilla.org, PDF viewer…). */
  });
});

browser.tabs.onRemoved.addListener((tabId) => enabledTabs.delete(tabId));

/* Re-apply the badge after in-tab navigation (badge text resets per page load). */
browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading' && enabledTabs.has(tabId)) setBadge(tabId, true);
});

/* ------------------------------------------------------------------ *
 * Teanglann lookup
 * ------------------------------------------------------------------ */

const cache = new Map(); // lowercased word -> result object
const CACHE_MAX = 500;
const FETCH_TIMEOUT_MS = 8000;

function fetchWithTimeout(url) {
  return fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
}

function cachePut(key, value) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, value);
}

/*
 * Strip the fetched markup down to something safe to inject into the popup:
 * keep only class/title/href, absolutise links, drop active content.
 */
function sanitize(root) {
  const BANNED = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META', 'FORM', 'INPUT', 'BUTTON']);
  for (const el of [...root.querySelectorAll('*')]) {
    if (BANNED.has(el.tagName)) {
      el.remove();
      continue;
    }
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      if (name === 'href') {
        try {
          const url = new URL(attr.value, BASE);
          if (url.protocol === 'https:' || url.protocol === 'http:') {
            el.setAttribute('href', url.href);
            continue;
          }
        } catch (e) { /* fall through to removal */ }
        el.removeAttribute(attr.name);
      } else if (name !== 'class' && name !== 'title') {
        el.removeAttribute(attr.name);
      }
    }
  }
}

function parseDoc(html) {
  return new DOMParser().parseFromString(html, 'text/html');
}

/*
 * Interpret one Teanglann page (an /ga/fgb/<word> entry page or a
 * /ga/_search/<word> results page — they share their markup):
 *
 *   .exacts .entry            exact dictionary entries — the good stuff
 *   .know a                   "Seans gur foirm é X de: Y »" — X is an inflected
 *                             form (urú, séimhiú, plural…) of headword Y
 *   .suggestions a            "Focail chosúla" — fuzzy suggestions
 */
async function interpret(doc, word, url, depth) {
  const entries = [...doc.querySelectorAll('.exacts .entry')];
  if (entries.length) {
    /* Headword as printed in the entry ("teach, " -> "teach") — used for the
       pronunciation lookup, which is keyed by headword, not inflected form. */
    const title = entries[0].querySelector('.title');
    const headword = title ? title.textContent.replace(/[,;:.\s]+$/g, '').trim() : word;
    const html = entries
      .slice(0, 4)
      .map((e) => {
        sanitize(e);
        return e.outerHTML;
      })
      .join('<hr class="entrysep">');
    return { status: 'entry', word, headword, html, sourceUrl: url };
  }

  const know = doc.querySelector('.know a');
  if (know && depth < 2) {
    const base = know.textContent.replace(/[» \s]+$/g, '').trim();
    if (base && base.toLowerCase() !== word.toLowerCase()) {
      const result = await doLookup(base, depth + 1);
      if (result.status === 'entry') {
        return { ...result, note: { formOf: base, original: word } };
      }
    }
  }

  const suggestions = [...doc.querySelectorAll('.suggestions a')]
    .map((a) => a.textContent.trim())
    .filter(Boolean)
    .slice(0, 8);
  if (suggestions.length) {
    return { status: 'suggestions', word, suggestions, sourceUrl: url };
  }

  return { status: 'none', word, sourceUrl: url };
}

async function doLookup(word, depth = 0) {
  const enc = encodeURIComponent(word);

  /* 1. Direct entry page: a miss is a clean 404. */
  let res = await fetchWithTimeout(`${BASE}/ga/fgb/${enc}`);
  if (res.ok) {
    const result = await interpret(parseDoc(await res.text()), word, res.url, depth);
    if (result.status !== 'none') return result;
  }

  /* 2. Site search: 302s straight to an entry page when unambiguous,
        otherwise a results page with .know / .suggestions — which Teanglann
        serves with a 404 status, so parse the body regardless. */
  res = await fetchWithTimeout(`${BASE}/ga/_search/${enc}`);
  if (res.status >= 500) return { status: 'error', word };
  return interpret(parseDoc(await res.text()), word, res.url, depth);
}

async function lookup(word) {
  const key = word.toLowerCase();
  if (cache.has(key)) return cache.get(key);
  try {
    const result = await doLookup(word);
    if (result.status !== 'error') cachePut(key, result);
    return result;
  } catch (e) {
    return { status: 'error', word, message: String(e) };
  }
}

/* ------------------------------------------------------------------ *
 * Pronunciation
 *
 * Sound files live at /Can{C,M,U}/<headword>.mp3 (Connachta/Mumhain/Ulaidh),
 * with a clean 404 when a recording doesn't exist. The audio is played HERE,
 * in the background page — an <audio> element in the content script would be
 * subject to the host page's CSP (media-src), the background page never is.
 * ------------------------------------------------------------------ */

const audioCache = new Map(); // "C:teach" -> object URL | null (known missing)
const AUDIO_CACHE_MAX = 60;
let currentAudio = null;

async function playAudio(word, dialect) {
  if (!/^[CMU]$/.test(dialect)) return { ok: false };
  const key = `${dialect}:${word.toLowerCase()}`;

  if (!audioCache.has(key)) {
    let url = null;
    try {
      const res = await fetchWithTimeout(`${BASE}/Can${dialect}/${encodeURIComponent(word.toLowerCase())}.mp3`);
      if (res.ok && (res.headers.get('content-type') || '').startsWith('audio/')) {
        url = URL.createObjectURL(await res.blob());
      }
    } catch (e) { /* treat as unavailable */ }
    if (audioCache.size >= AUDIO_CACHE_MAX) {
      const [oldKey, oldUrl] = audioCache.entries().next().value;
      if (oldUrl) URL.revokeObjectURL(oldUrl);
      audioCache.delete(oldKey);
    }
    audioCache.set(key, url);
  }

  const url = audioCache.get(key);
  if (!url) return { ok: false };

  if (currentAudio) currentAudio.pause();
  currentAudio = new Audio(url);
  try {
    await currentAudio.play();
    return { ok: true };
  } catch (e) {
    return { ok: false };
  }
}

/* ------------------------------------------------------------------ *
 * Messages from content scripts
 * ------------------------------------------------------------------ */

browser.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === 'getEnabled') {
    return Promise.resolve({ enabled: enabledTabs.has(sender.tab && sender.tab.id) });
  }
  if (msg.type === 'lookup') {
    return lookup(msg.word);
  }
  if (msg.type === 'playAudio') {
    return playAudio(msg.word, msg.dialect);
  }
  return undefined;
});
