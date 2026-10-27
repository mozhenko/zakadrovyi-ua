// Service worker: голос (системний через chrome.tts або онлайн Google через offscreen-документ),
// переклад (Google / DeepL / Claude), гаряча клавіша, значок.
importScripts('shared/settings.js');

// ---------------- Встановлення, значок, гаряча клавіша ----------------

chrome.runtime.onInstalled.addListener(async () => {
  const cur = await chrome.storage.sync.get(null);
  await chrome.storage.sync.set(Object.assign({}, UAV_DEFAULTS, cur));
  updateBadge();
});
chrome.runtime.onStartup.addListener(updateBadge);
chrome.storage.onChanged.addListener((ch, area) => { if (area === 'sync' && ch.enabled) updateBadge(); });

async function updateBadge() {
  const { enabled } = await chrome.storage.sync.get({ enabled: UAV_DEFAULTS.enabled });
  chrome.action.setBadgeBackgroundColor({ color: '#0057b7' });
  chrome.action.setBadgeText({ text: enabled ? 'UA' : '' });
}

chrome.commands.onCommand.addListener(async cmd => {
  if (cmd !== 'toggle-voice') return;
  const { enabled } = await chrome.storage.sync.get({ enabled: UAV_DEFAULTS.enabled });
  await chrome.storage.sync.set({ enabled: !enabled });
});

// ---------------- Допоміжне ----------------

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function fetchRetry(url, init, tries) {
  let last;
  for (let i = 0; i < (tries || 3); i++) {
    try {
      const r = await fetch(url, init);
      if (r.status === 429 || r.status >= 500) { last = new Error('HTTP ' + r.status); await new Promise(z => setTimeout(z, 700 * (i + 1))); continue; }
      return r;
    } catch (e) { last = e; await new Promise(z => setTimeout(z, 500 * (i + 1))); }
  }
  throw last;
}

// ---------------- Голоси ----------------

function getVoices() {
  return new Promise(res => chrome.tts.getVoices(v => res(v || [])));
}
async function ukVoices() {
  return (await getVoices()).filter(v => /^uk/i.test(v.lang || ''));
}
async function resolveEngine(s) {
  if (s.voiceEngine === 'system' || s.voiceEngine === 'google') return s.voiceEngine;
  return (await ukVoices()).length ? 'system' : 'google';
}

// Онлайн-голос Google (той самий, що в Перекладачі). Довгий текст ділимо на шматки ≤ 190 символів.
function splitForTTS(text, max) {
  const out = [];
  let rest = text.trim();
  while (rest.length > max) {
    let cut = Math.max(rest.lastIndexOf('. ', max), rest.lastIndexOf(', ', max), rest.lastIndexOf('; ', max));
    if (cut < max * 0.4) cut = rest.lastIndexOf(' ', max);
    if (cut <= 0) cut = max;
    out.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) out.push(rest);
  return out;
}

const ttsCache = new Map(); // text -> Promise<base64[]>
function googleTTS(text) {
  if (ttsCache.has(text)) return ttsCache.get(text);
  const parts = splitForTTS(text, 190);
  const p = Promise.all(parts.map((q, i) => {
    const url = 'https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=uk' +
      '&total=' + parts.length + '&idx=' + i + '&textlen=' + q.length + '&q=' + encodeURIComponent(q);
    return fetchRetry(url, {}, 2).then(r => {
      if (!r.ok) throw new Error('Google TTS: HTTP ' + r.status);
      return r.arrayBuffer();
    }).then(toBase64);
  }));
  ttsCache.set(text, p);
  p.catch(() => ttsCache.delete(text));
  if (ttsCache.size > 40) ttsCache.delete(ttsCache.keys().next().value);
  return p;
}

let creatingOffscreen = null;
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['AUDIO_PLAYBACK'],
      justification: 'Відтворення українського онлайн-голосу для озвучення відео'
    }).finally(() => { creatingOffscreen = null; });
  }
  await creatingOffscreen;
}

// Поточна репліка (одна на весь браузер)
let current = null; // {port, id, engine}

function notify(cur, type, extra) {
  try { cur.port.postMessage(Object.assign({ type, id: cur.id }, extra || {})); } catch (_) { /* порт закрито */ }
}

function stopCurrent() {
  const cur = current;
  if (!cur) return;
  current = null;
  if (cur.engine === 'system') chrome.tts.stop();
  else chrome.runtime.sendMessage({ target: 'offscreen', type: 'stop' }).catch(() => {});
  notify(cur, 'ended', { status: 'interrupted' });
}

async function speak(port, msg) {
  stopCurrent();
  const s = await uavGetSettings(false);
  const engine = await resolveEngine(s);
  const cur = { port, id: msg.id, engine };
  current = cur;
  const rate = Math.max(0.5, Math.min(3, Number(msg.rate) || 1));
  const volume = Math.max(0, Math.min(1, msg.volume == null ? 1 : Number(msg.volume)));

  if (engine === 'system') {
    const voices = await ukVoices();
    const voiceName = (s.voiceName && voices.some(v => v.voiceName === s.voiceName)) ? s.voiceName : (voices[0] && voices[0].voiceName);
    chrome.tts.speak(msg.text, {
      lang: 'uk-UA', voiceName, rate, volume, enqueue: false,
      onEvent: e => {
        if (current !== cur) return;
        if (e.type === 'start') notify(cur, 'started');
        if (['end', 'interrupted', 'cancelled', 'error'].includes(e.type)) {
          current = null;
          notify(cur, 'ended', { status: e.type === 'error' ? 'error' : 'end', error: e.errorMessage });
        }
      }
    });
    return;
  }

  try {
    const chunks = await googleTTS(msg.text);
    if (current !== cur) return;
    await ensureOffscreen();
    if (current !== cur) return;
    await chrome.runtime.sendMessage({ target: 'offscreen', type: 'play', id: msg.id, chunks, rate, volume });
    notify(cur, 'started');
  } catch (e) {
    if (current === cur) current = null;
    notify(cur, 'ended', { status: 'error', error: String(e && e.message || e) });
  }
}

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'uavoice') return;
  port.onMessage.addListener(async msg => {
    if (msg.type === 'speak') speak(port, msg);
    else if (msg.type === 'stop') { if (current && current.port === port) stopCurrent(); }
    else if (msg.type === 'prefetch') {
      const s = await uavGetSettings(false);
      if ((await resolveEngine(s)) === 'google') (msg.texts || []).forEach(t => googleTTS(t).catch(() => {}));
    }
  });
  port.onDisconnect.addListener(() => { if (current && current.port === port) stopCurrent(); });
});

// ---------------- Переклад ----------------

// Google: два незалежні неофіційні шлюзи. Якщо перший не відповідає — пробуємо другий.
async function gtx(q) {
  const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&dt=t&sl=auto&tl=uk&q=' + encodeURIComponent(q);
  const r = await fetchRetry(url, {}, 2);
  if (!r.ok) throw new Error('Google Translate (gtx): HTTP ' + r.status);
  const j = await r.json();
  if (!Array.isArray(j) || !Array.isArray(j[0])) throw new Error('Google Translate (gtx): неочікувана відповідь');
  return j[0].map(x => (x && typeof x[0] === 'string') ? x[0] : '').join('');
}

// Шлюз словника Chrome: приймає кілька q в одному запиті й повертає масив тієї ж довжини
async function dictChrome(texts) {
  const url = 'https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=auto&tl=uk&' +
    texts.map(t => 'q=' + encodeURIComponent(t)).join('&');
  const r = await fetchRetry(url, {}, 2);
  if (!r.ok) throw new Error('Google Translate (dict): HTTP ' + r.status);
  const j = await r.json();
  const pick = x => {
    if (typeof x === 'string') return x;
    if (Array.isArray(x)) return pick(x[0]);
    if (x && typeof x === 'object') return x.trans || (x.sentences || []).map(z => z.trans || '').join('') || '';
    return '';
  };
  let arr = Array.isArray(j) ? j : (j && j.sentences ? [j] : []);
  if (texts.length === 1 && arr.length && !Array.isArray(arr[0]) && typeof arr[0] === 'string') arr = [arr[0]];
  if (arr.length !== texts.length) throw new Error('Google Translate (dict): неочікувана відповідь');
  return arr.map(pick);
}

function packChunks(texts, limit) {
  const chunks = [];
  let chunk = [], len = 0;
  texts.forEach((t, i) => {
    const enc = encodeURIComponent(t).length + 3;
    if (chunk.length && len + enc > limit) { chunks.push(chunk); chunk = []; len = 0; }
    chunk.push(i); len += enc;
  });
  if (chunk.length) chunks.push(chunk);
  return chunks;
}

async function translateGoogle(texts) {
  const out = new Array(texts.length).fill('');
  for (const c of packChunks(texts, 1800)) {
    const part = c.map(i => texts[i].replace(/\n/g, ' '));
    let done = false;
    let firstErr = null;
    try {
      const lines = (await gtx(part.join('\n'))).split('\n');
      if (lines.length === c.length) { c.forEach((i, k) => { out[i] = lines[k].trim(); }); done = true; }
    } catch (e) { firstErr = e; console.warn('[Закадровий UA]', e.message); }
    if (!done) {
      try {
        const res = await dictChrome(part);
        c.forEach((i, k) => { out[i] = String(res[k] || '').trim(); });
        done = true;
      } catch (e) { console.warn('[Закадровий UA]', e.message); if (!firstErr) firstErr = e; }
    }
    if (!done) {
      if (firstErr) throw firstErr;
      for (const i of c) out[i] = (await gtx(texts[i])).trim();
    }
  }
  return out;
}

async function translateDeepL(texts, key) {
  if (!key) throw new Error('Не вказано API-ключ DeepL (розділ «Ключі API»)');
  const host = key.trim().endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com';
  const r = await fetchRetry(host + '/v2/translate', {
    method: 'POST',
    headers: { 'Authorization': 'DeepL-Auth-Key ' + key.trim(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: texts, target_lang: 'UK', preserve_formatting: true })
  }, 2);
  if (r.status === 403) throw new Error('DeepL відхилив ключ (403)');
  if (r.status === 456) throw new Error('Вичерпано ліміт DeepL (456)');
  if (!r.ok) throw new Error('DeepL: HTTP ' + r.status);
  const j = await r.json();
  return j.translations.map(t => t.text);
}

const CLAUDE_SYSTEM =
  'Ти — перекладач закадрового озвучення відео. Тобі дають JSON з назвою відео і масивом "lines" — ' +
  'послідовні фрази субтитрів (часто автоматичних, без розділових знаків і з помилками розпізнавання). ' +
  'Переклади кожну фразу українською так, щоб її було природно прочитати вголос: жива розмовна мова, ' +
  'стисло (переклад не має бути довшим за оригінал), виправляй очевидні помилки розпізнавання з урахуванням контексту, ' +
  'імена й терміни передавай за українською традицією. Не об\'єднуй і не розбивай фрази. ' +
  'Відповідай ЛИШЕ JSON-масивом рядків тієї самої довжини, що й "lines", без пояснень.';

async function translateClaude(texts, key, model, title) {
  if (!key) throw new Error('Не вказано API-ключ Claude (розділ «Ключі API»)');
  const r = await fetchRetry('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key.trim(),
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: model || UAV_DEFAULTS.claudeModel,
      max_tokens: 4096,
      system: CLAUDE_SYSTEM,
      messages: [{ role: 'user', content: JSON.stringify({ title, lines: texts }) }]
    })
  }, 2);
  if (r.status === 401) throw new Error('Claude відхилив ключ (401)');
  if (!r.ok) {
    let detail = '';
    try { detail = (await r.json()).error.message; } catch (_) { /* ignore */ }
    throw new Error('Claude: HTTP ' + r.status + (detail ? ' — ' + detail : ''));
  }
  const j = await r.json();
  const txt = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  const m = txt.match(/\[[\s\S]*\]/);
  const arr = m ? JSON.parse(m[0]) : null;
  if (!Array.isArray(arr) || arr.length !== texts.length) throw new Error('Claude повернув відповідь у неочікуваному форматі');
  return arr.map(x => String(x));
}

async function translate(msg) {
  const s = await uavGetSettings(true);
  const texts = msg.texts || [];
  try {
    if (s.translator === 'deepl') return { ok: true, texts: await translateDeepL(texts, s.deeplKey) };
    if (s.translator === 'claude') return { ok: true, texts: await translateClaude(texts, s.claudeKey, s.claudeModel, msg.title) };
    return { ok: true, texts: await translateGoogle(texts) };
  } catch (e) {
    // запасний варіант — безкоштовний Google
    if (s.translator !== 'google') {
      try {
        return { ok: true, texts: await translateGoogle(texts), note: String(e.message || e) + ' → тимчасово використано Google' };
      } catch (_) { /* fall through */ }
    }
    console.warn('[Закадровий UA] переклад не вдався:', e);
    return { ok: false, error: String(e && e.message || e) };
  }
}

// ---------------- Повідомлення ----------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  if (msg.from === 'offscreen' && msg.type === 'ended') {
    if (current && current.id === msg.id && current.engine !== 'system') {
      const cur = current;
      current = null;
      notify(cur, 'ended', { status: msg.status, error: msg.error });
    }
    return;
  }
  if (msg.type === 'translate') {
    translate(msg).then(sendResponse, e => sendResponse({ ok: false, error: String(e && e.message || e) }));
    return true;
  }
  if (msg.type === 'testTranslate') {
    translate({ texts: ['Hello everyone, and welcome to today\'s lecture on film editing.', 'Let\'s start with a short history of montage.'], title: 'Test' })
      .then(sendResponse, e => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.type === 'getVoices') {
    ukVoices().then(v => sendResponse(v.map(x => ({ name: x.voiceName, lang: x.lang, remote: !!x.remote }))));
    return true;
  }
  if (msg.type === 'testVoice') {
    // перевірка голосу зі спливаючого вікна: фіктивний «порт»
    const fakePort = { postMessage: () => {} };
    speak(fakePort, { id: 'test-' + Date.now(), text: msg.text, rate: msg.rate, volume: msg.volume });
    sendResponse({ ok: true });
    return;
  }
});
