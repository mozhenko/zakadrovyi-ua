// Content-скрипт для YouTube: знаходить доріжку субтитрів, отримує її
// (оригінал або автопереклад YouTube українською) і передає контролеру.
(() => {
  'use strict';
  if (globalThis.__uavYouTube) return;
  globalThis.__uavYouTube = true;

  const core = globalThis.UAVoice;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const player = () => document.getElementById('movie_player') || document.querySelector('.html5-video-player');

  const ctl = new core.Controller({
    isBlocked: () => {
      const p = player();
      return !!(p && (p.classList.contains('ad-showing') || p.classList.contains('ad-interrupting')));
    },
    overlayParent: () => player() || document.body,
    useGain: true,
    onTranslateFailure: msg => {
      // перекладач не відповідає — переходимо на автопереклад YouTube, щоб голос не замовк
      if (fallbackToYT || !currentVid) return;
      fallbackToYT = true;
      fallbackReason = msg;
      loadVideo(currentVid);
    }
  });
  let fallbackToYT = false;
  let fallbackReason = '';

  let settings = null;
  let currentVid = null;
  let loadGen = 0;
  let lastFailNeedCC = false;

  // ---- зв'язок зі скриптом у світі сторінки ----
  const pending = new Map();
  let reqId = 0;
  window.addEventListener('message', e => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.__uavoice !== 'uavoice-main' || !pending.has(d.id)) return;
    pending.get(d.id)(d.result);
    pending.delete(d.id);
  });
  function main(type, payload, timeout) {
    const id = 'r' + (++reqId) + '_' + Math.random().toString(36).slice(2);
    return new Promise(resolve => {
      const tm = setTimeout(() => { pending.delete(id); resolve(null); }, timeout || 15000);
      pending.set(id, r => { clearTimeout(tm); resolve(r); });
      window.postMessage({ __uavoice: 'uavoice-cs', id, type, payload }, '*');
    });
  }

  function videoIdFromUrl() {
    const u = new URL(location.href);
    if (u.pathname === '/watch') return u.searchParams.get('v');
    const m = u.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]{6,})/);
    return m ? m[1] : null;
  }

  function findVideo() {
    const p = player();
    return (p && p.querySelector('video')) || document.querySelector('video.html5-main-video') || document.querySelector('video');
  }

  const base = c => String(c || '').toLowerCase().split(/[-_]/)[0];

  function choosePlan(tracks, s) {
    const asr = tracks.find(t => t.kind === 'asr');
    const manual = tracks.filter(t => t.kind !== 'asr');
    const ukManual = manual.find(t => base(t.languageCode) === 'uk');
    if (ukManual) return { track: ukManual, tlang: null, needsTranslation: false, label: 'Українські субтитри автора' };

    const orig = asr ? base(asr.languageCode) : null;
    const src = (orig && manual.find(t => base(t.languageCode) === orig)) || asr ||
      manual.find(t => base(t.languageCode) === 'en') || manual[0];
    if (!src) return null;
    const srcName = src.name + (src.kind === 'asr' && !/авто|auto/i.test(src.name) ? ' (авто)' : '');

    if (base(src.languageCode) === 'uk') return { alreadyUk: true };

    if ((s.mode === 'youtube' || fallbackToYT) && src.isTranslatable) {
      const note = s.mode !== 'youtube' ? ` — резервно, бо перекладач недоступний: ${fallbackReason}` : '';
      return { track: src, tlang: 'uk', needsTranslation: false, label: `${srcName} → українська (YouTube)${note}` };
    }
    const engine = { google: 'Google', deepl: 'DeepL', claude: 'Claude' }[s.translator] || s.translator;
    return { track: src, tlang: null, needsTranslation: true, label: `${srcName} → українська (${engine})` };
  }

  async function loadVideo(vid) {
    const gen = ++loadGen;
    ctl.clear('Шукаю субтитри…');
    ctl.attachVideo(findVideo());

    let info = null;
    for (let i = 0; i < 30; i++) {
      info = await main('getTracks', { videoId: vid }, 4000);
      if (gen !== loadGen) return;
      if (info && info.ready) break;
      await sleep(500);
    }
    if (!info || !info.ready) { ctl.setStatus('Не вдалося прочитати дані плеєра YouTube'); return; }
    if (!info.tracks.length) { ctl.setStatus('У цього відео немає субтитрів — озвучувати нічого'); return; }

    const plan = choosePlan(info.tracks, settings);
    if (!plan) { ctl.setStatus('Не знайдено придатної доріжки субтитрів'); return; }
    if (plan.alreadyUk) { ctl.setStatus('Відео вже українською — озвучення не потрібне'); return; }

    ctl.setStatus('Завантажую субтитри…');
    const res = await main('fetchCaptions', { videoId: vid, track: plan.track, tlang: plan.tlang }, 20000);
    if (gen !== loadGen) return;
    if (!res || !res.ok) {
      lastFailNeedCC = !!(res && res.needCC);
      ctl.setStatus((res && res.error) || 'Не вдалося завантажити субтитри');
      return;
    }
    lastFailNeedCC = false;
    const phrases = core.buildPhrases(core.parseJson3(res.json));
    if (!phrases.length) { ctl.setStatus('Субтитри порожні'); return; }

    ctl.attachVideo(findVideo());
    ctl.load(phrases, { needsTranslation: plan.needsTranslation, label: plan.label, title: info.title });
    if (settings.enabled) ctl.start();
  }

  function check(force) {
    if (!settings) return;
    const vid = videoIdFromUrl();
    const v = findVideo();
    if (!vid || !v) {
      if (currentVid) { currentVid = null; ctl.stop('Очікування відео'); }
      return;
    }
    if (ctl.video !== v) ctl.attachVideo(v);
    if (vid !== currentVid || force) {
      currentVid = vid;
      fallbackToYT = false;
      ctl.stop();
      if (settings.enabled) loadVideo(vid);
      else ctl.setStatus('Озвучення вимкнено');
    } else if (lastFailNeedCC && settings.enabled) {
      // користувач міг увімкнути CC — пробуємо ще раз, щойно плеєр отримав субтитри
      main('hasCaptured', { videoId: vid }, 2000).then(has => {
        if (has && lastFailNeedCC) { lastFailNeedCC = false; loadVideo(vid); }
      });
    }
  }

  // ---- налаштування ----
  async function init() {
    settings = await core.getSettings();
    ctl.setSettings(settings);
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      const prev = settings;
      settings = Object.assign({}, settings);
      for (const k of Object.keys(changes)) settings[k] = changes[k].newValue;
      ctl.setSettings(settings);
      if ('enabled' in changes && prev.enabled !== settings.enabled) {
        if (settings.enabled) check(true); else ctl.stop('Озвучення вимкнено');
        return;
      }
      if ((('mode' in changes) || ('translator' in changes)) && settings.enabled) check(true);
    });
    document.addEventListener('yt-navigate-finish', () => setTimeout(() => check(false), 300));
    setInterval(() => check(false), 1200);
    check(false);
  }

  // ---- статус для спливаючого вікна ----
  chrome.runtime.onMessage.addListener((m, sender, sendResponse) => {
    if (!m || m.type !== 'uav-status') return;
    if (!findVideo() || !videoIdFromUrl()) return;
    sendResponse({ site: 'youtube', status: ctl.status, active: ctl.active, enabled: settings && settings.enabled });
  });

  init();
})();
