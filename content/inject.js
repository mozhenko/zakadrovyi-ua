// Виконується у світі сторінки (MAIN world) YouTube.
// Завдання: побачити, які запити субтитрів робить сам плеєр (вони містять
// токен Proof-of-Origin, без якого YouTube з 2026 р. повертає порожні субтитри),
// і на прохання content-скрипта завантажити потрібну доріжку з тим самим токеном.
(() => {
  'use strict';
  if (window.__uavoiceMain) return;
  window.__uavoiceMain = true;

  const TAG_IN = 'uavoice-cs';
  const TAG_OUT = 'uavoice-main';
  const nativeFetch = window.fetch.bind(window);
  const captured = new Map(); // videoId -> URL запиту плеєра, що повернув непорожні дані

  function note(url, ok) {
    try {
      const u = new URL(url, location.href);
      if (!u.pathname.endsWith('/api/timedtext') || !ok) return;
      const v = u.searchParams.get('v');
      if (v) captured.set(v, u.toString());
    } catch (_) { /* ignore */ }
  }

  // --- перехоплення fetch ---
  window.fetch = function (input, init) {
    const p = nativeFetch(input, init);
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || String(input);
      if (url.includes('/api/timedtext')) {
        p.then(r => r.clone().text()).then(t => note(url, t.length > 0)).catch(() => {});
      }
    } catch (_) { /* ignore */ }
    return p;
  };

  // --- перехоплення XMLHttpRequest ---
  const xOpen = XMLHttpRequest.prototype.open;
  const xSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    try { this.__uavUrl = String(url); } catch (_) { /* ignore */ }
    return xOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    if (this.__uavUrl && this.__uavUrl.includes('/api/timedtext')) {
      this.addEventListener('load', () => {
        try {
          let len = 0;
          if (this.responseType === '' || this.responseType === 'text') len = (this.responseText || '').length;
          else if (this.response) len = this.response.byteLength || this.response.length || 1;
          note(this.__uavUrl, len > 0);
        } catch (_) { /* ignore */ }
      });
    }
    return xSend.apply(this, arguments);
  };

  // --- допоміжне ---
  const getPlayer = () => document.getElementById('movie_player') || document.querySelector('.html5-video-player');
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function playerResponse(videoId) {
    const p = getPlayer();
    let r = null;
    try { r = p && p.getPlayerResponse ? p.getPlayerResponse() : null; } catch (_) { /* ignore */ }
    if (!r || !r.videoDetails || r.videoDetails.videoId !== videoId) {
      const w = window.ytInitialPlayerResponse;
      if (w && w.videoDetails && w.videoDetails.videoId === videoId) r = w;
    }
    return r && r.videoDetails && r.videoDetails.videoId === videoId ? r : null;
  }

  function trackName(t) {
    const n = t.name || {};
    return n.simpleText || (n.runs || []).map(x => x.text).join('') || t.languageCode;
  }

  function getTracks({ videoId }) {
    const r = playerResponse(videoId);
    if (!r) return { ready: false };
    const list = (((r.captions || {}).playerCaptionsTracklistRenderer || {}).captionTracks) || [];
    return {
      ready: true,
      title: r.videoDetails.title || '',
      tracks: list.map(t => ({
        baseUrl: t.baseUrl,
        languageCode: t.languageCode || '',
        kind: t.kind || '',
        name: trackName(t),
        isTranslatable: t.isTranslatable !== false
      }))
    };
  }

  function turnOnCaptions(track) {
    const p = getPlayer();
    if (!p) return false;
    try {
      if (p.loadModule) p.loadModule('captions');
      if (p.setOption) {
        p.setOption('captions', 'track', { languageCode: track.languageCode, kind: track.kind || undefined });
        return true;
      }
    } catch (_) { /* ignore */ }
    const btn = document.querySelector('.ytp-subtitles-button');
    if (btn && btn.getAttribute('aria-pressed') !== 'true') { btn.click(); return true; }
    return false;
  }

  function turnOffCaptions() {
    const p = getPlayer();
    try { if (p && p.setOption) p.setOption('captions', 'track', {}); } catch (_) { /* ignore */ }
    try { if (p && p.unloadModule) p.unloadModule('captions'); } catch (_) { /* ignore */ }
    const btn = document.querySelector('.ytp-subtitles-button');
    if (btn && btn.getAttribute('aria-pressed') === 'true') btn.click();
  }

  const SKIP = new Set(['lang', 'kind', 'tlang', 'name', 'fmt', 'v']);

  function buildUrl(track, tlang, donorUrl) {
    const u = new URL(track.baseUrl, location.origin);
    if (donorUrl) {
      const d = new URL(donorUrl);
      for (const [k, val] of d.searchParams) {
        if (!SKIP.has(k) && !u.searchParams.has(k)) u.searchParams.set(k, val);
      }
    }
    u.searchParams.set('fmt', 'json3');
    if (tlang) u.searchParams.set('tlang', tlang); else u.searchParams.delete('tlang');
    return u.toString();
  }

  async function getJson(url) {
    const r = await nativeFetch(url, { credentials: 'include' });
    if (r.status === 429) throw new Error('YouTube тимчасово обмежив запити (429). Спробуйте за хвилину.');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const t = await r.text();
    if (!t.trim()) return null;
    return JSON.parse(t);
  }

  async function fetchCaptions({ videoId, track, tlang }) {
    // 1. Пряма спроба (працює для доріжок без вимоги токена)
    if (!/[?&]exp=xpe/.test(track.baseUrl)) {
      try {
        const j = await getJson(buildUrl(track, tlang, null));
        if (j && j.events) return { ok: true, json: j };
      } catch (e) {
        if (/429/.test(e.message)) return { ok: false, error: e.message };
      }
    }
    // 2. Беремо токен із запиту самого плеєра; якщо його ще не було — вмикаємо субтитри
    let donor = captured.get(videoId);
    let turnedOn = false;
    if (!donor) {
      const cc = document.querySelector('.ytp-subtitles-button');
      const wasOn = cc && cc.getAttribute('aria-pressed') === 'true';
      turnedOn = turnOnCaptions(track) && !wasOn;
      for (let i = 0; i < 40 && !captured.get(videoId); i++) await sleep(200);
      donor = captured.get(videoId);
    }
    try {
      if (!donor) {
        return { ok: false, error: 'Не вдалося отримати субтитри автоматично. Увімкніть субтитри (кнопка CC) у плеєрі — розширення підхопить їх.', needCC: true };
      }
      const j = await getJson(buildUrl(track, tlang, donor));
      if (j && j.events) return { ok: true, json: j };
      return { ok: false, error: 'YouTube повернув порожні субтитри. Увімкніть CC у плеєрі й спробуйте ще раз.', needCC: true };
    } catch (e) {
      return { ok: false, error: e.message };
    } finally {
      if (turnedOn) setTimeout(turnOffCaptions, 300);
    }
  }

  const handlers = { getTracks, fetchCaptions, hasCaptured: ({ videoId }) => captured.has(videoId) };

  window.addEventListener('message', async (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.__uavoice !== TAG_IN || !handlers[d.type]) return;
    let result;
    try { result = await handlers[d.type](d.payload || {}); } catch (err) { result = { ok: false, error: String(err && err.message || err) }; }
    window.postMessage({ __uavoice: TAG_OUT, id: d.id, result }, '*');
  });
})();
