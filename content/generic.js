// Озвучення відео на будь-якому сайті, де субтитри підключені як HTML5 text tracks
// (Vimeo, TED, освітні платформи, власні плеєри). Вмикається кнопкою у спливаючому вікні.
(() => {
  'use strict';
  const core = globalThis.UAVoice;

  if (globalThis.__uavGeneric) { globalThis.__uavGeneric.restart(); return; }

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const base = c => String(c || '').toLowerCase().split(/[-_]/)[0];
  let settings = null;
  let video = null;
  let track = null;
  let lastCount = -1;
  let poll = null;

  const ctl = new core.Controller({
    overlayParent: () => document.fullscreenElement || document.body,
    fixedOverlay: true
  });

  function pickVideo() {
    const vids = [...document.querySelectorAll('video')].filter(v => v.offsetWidth * v.offsetHeight > 0);
    vids.sort((a, b) => {
      const pa = !a.paused ? 1 : 0, pb = !b.paused ? 1 : 0;
      if (pa !== pb) return pb - pa;
      return b.offsetWidth * b.offsetHeight - a.offsetWidth * a.offsetHeight;
    });
    return vids[0] || null;
  }

  function pickTrack(v) {
    const list = [...v.textTracks].filter(t => t.kind === 'subtitles' || t.kind === 'captions');
    if (!list.length) return null;
    const docLang = base(document.documentElement.lang);
    return list.find(t => base(t.language) === 'uk') ||
      list.find(t => t.mode === 'showing') ||
      (docLang && list.find(t => base(t.language) === docLang)) ||
      list.find(t => base(t.language) === 'en') || list[0];
  }

  function readCues(t) {
    const cues = t.cues ? [...t.cues] : [];
    return cues.map(c => ({ start: c.startTime * 1000, end: c.endTime * 1000, text: c.text || '' }));
  }

  async function start() {
    settings = await core.getSettings();
    ctl.setSettings(settings);
    video = pickVideo();
    if (!video) { ctl.setStatus('На сторінці не знайдено відео'); return; }
    ctl.attachVideo(video);
    track = pickTrack(video);
    if (!track) {
      ctl.setStatus('У відео немає вбудованих субтитрів (text tracks) — на цьому сайті озвучення неможливе');
      return;
    }
    if (track.mode === 'disabled') track.mode = 'hidden';
    ctl.setStatus('Завантажую субтитри…');
    for (let i = 0; i < 40 && !(track.cues && track.cues.length); i++) await sleep(250);
    if (!track.cues || !track.cues.length) { ctl.setStatus('Субтитри не завантажились. Увімкніть їх у плеєрі та натисніть «Озвучити» ще раз.'); return; }

    const uk = base(track.language) === 'uk';
    const label = `${track.label || track.language || 'Субтитри'} → українська` + (uk ? '' : ` (${{ google: 'Google', deepl: 'DeepL', claude: 'Claude' }[settings.translator]})`);
    lastCount = track.cues.length;
    ctl.load(core.buildPhrases(readCues(track)), { needsTranslation: !uk, label, title: document.title });
    ctl.start();

    // субтитри потокових плеєрів довантажуються частинами
    clearInterval(poll);
    poll = setInterval(() => {
      if (!track || !track.cues) return;
      if (track.cues.length !== lastCount) {
        lastCount = track.cues.length;
        ctl.update(core.buildPhrases(readCues(track)));
      }
    }, 3000);
  }

  function stop() {
    clearInterval(poll);
    ctl.stop('Зупинено');
  }

  chrome.runtime.onMessage.addListener((m, sender, sendResponse) => {
    if (!m) return;
    if (m.type === 'uav-status') {
      if (!video) return;
      sendResponse({ site: 'generic', status: ctl.status, active: ctl.active });
    } else if (m.type === 'uav-generic-stop') {
      stop();
      sendResponse({ ok: true });
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !settings) return;
    for (const k of Object.keys(changes)) settings[k] = changes[k].newValue;
    ctl.setSettings(settings);
    if ('translator' in changes && ctl.active) { stop(); start(); }
  });

  globalThis.__uavGeneric = { restart: () => { stop(); start(); } };
  start();
})();
