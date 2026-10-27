// Ядро: розбір субтитрів, складання фраз, синхронізація голосу з відео,
// приглушення оригіналу, накладка з текстом. Спільне для YouTube і будь-яких сайтів.
(() => {
  'use strict';
  if (globalThis.UAVoice) return;

  // ---------------- Текст і субтитри ----------------

  function cleanText(s) {
    return String(s || '')
      .replace(/\[[^\]]*\]/g, ' ')      // [Music], [Сміх] …
      .replace(/\([^)]*(music|музика|applause|оплески|laughter|сміх)[^)]*\)/gi, ' ')
      .replace(/[♪♫♬]+/g, ' ')
      .replace(/&gt;&gt;|>>/g, ' ')      // маркер зміни мовця
      .replace(/<[^>]+>/g, ' ')          // теги WebVTT
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Формат json3 YouTube -> [{start, end, text, word}]
  function parseJson3(data) {
    const segs = [];
    const events = (data && data.events) || [];
    for (const ev of events) {
      if (!ev.segs || ev.aAppend) continue;
      const t0 = ev.tStartMs || 0;
      const dur = ev.dDurationMs || 0;
      const parts = ev.segs.filter(s => s.utf8 && s.utf8 !== '\n');
      if (!parts.length) continue;
      const wordTimed = parts.length > 1 && parts.some(s => s.tOffsetMs != null);
      if (wordTimed) {
        parts.forEach((s, i) => {
          const st = t0 + (s.tOffsetMs || 0);
          const nx = parts[i + 1];
          const en = nx ? t0 + (nx.tOffsetMs || 0) : t0 + dur;
          segs.push({ start: st, end: Math.max(en, st + 80), text: s.utf8, word: true });
        });
      } else {
        segs.push({ start: t0, end: t0 + dur, text: parts.map(s => s.utf8).join('') });
      }
    }
    segs.sort((a, b) => a.start - b.start);
    // У автоматичних субтитрах рядки «перекриваються» — обрізаємо кінець слова
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      if (!s.word) continue;
      const nx = segs[i + 1];
      s.end = Math.min(s.end, nx ? nx.start : s.end, s.start + 900);
      if (s.end < s.start + 80) s.end = s.start + 80;
    }
    return segs;
  }

  // Об'єднуємо рядки/слова у фрази, зручні для озвучення й перекладу
  function buildPhrases(rawSegs, opts) {
    const o = Object.assign({ maxMs: 8000, maxChars: 200, gapMs: 900, minChars: 12 }, opts || {});
    const segs = rawSegs
      .map(s => ({ start: s.start, end: s.end, word: !!s.word, text: s.word ? String(s.text).replace(/\n/g, ' ') : cleanText(s.text) }))
      .filter(s => s.text.trim() && cleanText(s.text))
      .sort((a, b) => a.start - b.start);

    const out = [];
    let cur = null;
    let prev = null;
    const flush = () => {
      if (cur) {
        const text = cleanText(cur.text);
        if (text) out.push({ start: cur.start, end: cur.end, text });
      }
      cur = null;
    };

    for (const s of segs) {
      // дублікати (повтори рядка у «рулонних» субтитрах)
      if (prev && !s.word && s.text === prev.text && s.start - prev.start < 2000) { prev = s; continue; }
      prev = s;
      if (cur && s.start - cur.end > o.gapMs) flush();
      if (cur && (s.end - cur.start > o.maxMs || cur.text.length + s.text.length > o.maxChars)) flush();
      if (!cur) cur = { start: s.start, end: s.end, text: '' };
      const needSpace = cur.text && !/^\s/.test(s.text) && !/\s$/.test(cur.text);
      cur.text += (needSpace ? ' ' : '') + s.text;
      cur.end = Math.max(cur.end, s.end);
      if (/[.!?…。！？][»"”')\]]*\s*$/.test(s.text) && cleanText(cur.text).length >= o.minChars) flush();
    }
    flush();
    return out;
  }

  // ---------------- Мовлення (через background) ----------------

  class Speaker {
    constructor() {
      this.port = null;
      this.pending = new Map();
      this.seq = 0;
      this.onStart = null;
    }
    ensure() {
      if (this.port) return this.port;
      this.port = chrome.runtime.connect({ name: 'uavoice' });
      this.port.onMessage.addListener(m => {
        const p = this.pending.get(m.id);
        if (!p) return;
        if (m.type === 'started') { if (p.onStart) p.onStart(); return; }
        if (m.type === 'ended') { this.pending.delete(m.id); p.resolve(m); }
      });
      this.port.onDisconnect.addListener(() => {
        this.port = null;
        for (const p of this.pending.values()) p.resolve({ status: 'interrupted' });
        this.pending.clear();
      });
      return this.port;
    }
    speak(text, opts, onStart) {
      const id = ++this.seq;
      return new Promise(resolve => {
        this.pending.set(id, { resolve, onStart });
        try {
          this.ensure().postMessage(Object.assign({ type: 'speak', id, text }, opts));
        } catch (e) {
          this.pending.delete(id);
          resolve({ status: 'error', error: String(e) });
        }
      });
    }
    prefetch(texts) {
      try { this.ensure().postMessage({ type: 'prefetch', texts }); } catch (_) { /* ignore */ }
    }
    stop() {
      try { if (this.port) this.port.postMessage({ type: 'stop' }); } catch (_) { /* ignore */ }
      for (const p of this.pending.values()) p.resolve({ status: 'interrupted' });
      this.pending.clear();
    }
  }

  // ---------------- Накладка з текстом ----------------

  class Overlay {
    constructor() {
      const el = document.createElement('div');
      el.className = 'uavoice-overlay';
      el.setAttribute('aria-live', 'polite');
      Object.assign(el.style, {
        position: 'absolute', left: '50%', bottom: '13%', transform: 'translateX(-50%)',
        maxWidth: '82%', padding: '6px 14px', borderRadius: '6px',
        background: 'rgba(10, 12, 20, 0.78)', color: '#fff',
        font: '600 clamp(14px, 2.1vw, 26px)/1.35 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
        textAlign: 'center', zIndex: '2147483000', pointerEvents: 'none',
        borderLeft: '3px solid #ffd500', opacity: '0', transition: 'opacity .18s ease',
        textShadow: '0 1px 2px rgba(0,0,0,.6)', whiteSpace: 'pre-wrap'
      });
      this.el = el;
      this.hideTimer = null;
    }
    mount(parent, fixed) {
      if (!parent) return;
      this.el.style.position = fixed ? 'fixed' : 'absolute';
      if (this.el.parentNode !== parent) parent.appendChild(this.el);
    }
    placeOver(rect) {
      if (!rect) return;
      this.el.style.left = (rect.left + rect.width / 2) + 'px';
      this.el.style.bottom = (window.innerHeight - rect.bottom + rect.height * 0.12) + 'px';
      this.el.style.maxWidth = Math.round(rect.width * 0.85) + 'px';
    }
    show(text) {
      clearTimeout(this.hideTimer);
      this.el.textContent = text;
      this.el.style.opacity = '1';
    }
    hide(delay) {
      clearTimeout(this.hideTimer);
      this.hideTimer = setTimeout(() => { this.el.style.opacity = '0'; }, delay || 0);
    }
    remove() { this.el.remove(); }
  }


  // ---------------- Приглушення оригіналу (ducking) ----------------
  // Основний спосіб — підсилювач Web Audio після плеєра: YouTube може як завгодно
  // змінювати video.volume (вирівнювання гучності, власний повзунок), а наш
  // GainNode стоїть далі в тракті й лишається недоторканим.
  // Запасний спосіб — video.volume з постійним контролем: якщо хтось змінив
  // гучність під час приглушення, ми приймаємо нове значення як базове
  // й одразу знову приглушуємо.
  const graphs = new WeakMap();
  let sharedCtx = null;

  class Ducker {
    constructor(useGain) {
      this.useGain = useGain;
      this.video = null;
      this.level = 0.25;
      this.ducked = false;
      this.base = null;      // базова гучність для режиму video.volume
      this.lastSet = null;   // що ми самі записали у video.volume
      this.fadeTimer = null;
      this.gainFailed = false;
    }
    setLevel(l) {
      const n = Number(l);
      this.level = isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.25;
      if (this.ducked) this.apply(120);
    }
    attach(v) {
      if (this.video === v) return;
      this.release();
      this.video = v;
    }
    graph() {
      const v = this.video;
      if (!v || !this.useGain) return null;
      const g = graphs.get(v);
      if (g) {
        if (g.ctx.state !== 'running') g.ctx.resume().catch(() => {});
        return g;
      }
      if (this.gainFailed) return null;
      try {
        if (!sharedCtx) {
          sharedCtx = new AudioContext({ latencyHint: 'playback' });
          sharedCtx.addEventListener('statechange', () => {
            if (sharedCtx.state === 'suspended') sharedCtx.resume().catch(() => {});
          });
        }
        // підключаємо відео до Web Audio лише коли контекст уже працює,
        // інакше звук відео зник би до першого кліку на сторінці
        if (sharedCtx.state !== 'running') { sharedCtx.resume().catch(() => {}); return null; }
        const src = sharedCtx.createMediaElementSource(v);
        const gain = sharedCtx.createGain();
        src.connect(gain);
        gain.connect(sharedCtx.destination);
        const ng = { ctx: sharedCtx, gain };
        graphs.set(v, ng);
        // якщо до цього приглушували через video.volume — повертаємо гучність
        if (this.base != null) {
          clearInterval(this.fadeTimer);
          v.volume = this.base;
          this.base = null;
          this.lastSet = null;
        }
        return ng;
      } catch (e) {
        console.warn('[Закадровий UA] Web Audio недоступне, використовую video.volume:', e);
        this.gainFailed = true;
        return null;
      }
    }
    duck() { if (this.level >= 1) return; this.ducked = true; this.apply(180); }
    unduck(immediate) { if (!this.ducked && this.base == null) return; this.ducked = false; this.apply(immediate ? 0 : 350); }
    apply(ms) {
      const target = this.ducked ? this.level : 1;
      const g = this.graph();
      if (g) {
        const p = g.gain.gain;
        const t = g.ctx.currentTime;
        p.cancelScheduledValues(t);
        p.setValueAtTime(p.value, t);
        g.lastRampEnd = t + ms / 1000 + 0.05;
        if (ms > 0) p.linearRampToValueAtTime(target, t + ms / 1000);
        else p.setValueAtTime(target, t);
        return;
      }
      this.applyVolume(target, ms);
    }
    applyVolume(target, ms) {
      const v = this.video;
      if (!v) return;
      if (this.base == null) {
        if (target >= 1) return;
        this.base = v.volume;
      }
      const goal = Math.max(0, Math.min(1, this.base * target));
      clearInterval(this.fadeTimer);
      const from = v.volume;
      const steps = Math.max(1, Math.round(ms / 20));
      let n = 0;
      const step = () => {
        n++;
        const val = n >= steps ? goal : from + (goal - from) * (n / steps);
        v.volume = val;
        this.lastSet = v.volume;
        if (n >= steps) {
          clearInterval(this.fadeTimer);
          if (target >= 1) { this.base = null; this.lastSet = null; }
        }
      };
      if (ms <= 0) { n = steps - 1; step(); } else this.fadeTimer = setInterval(step, 20);
    }
    // викликається кожні 120 мс: стежимо, щоб ніхто не «повернув» гучність під час мовлення
    enforce() {
      const v = this.video;
      if (!v) return;
      const g = graphs.get(v);
      if (g) {
        if (g.ctx.state !== 'running') g.ctx.resume().catch(() => {});
        const want = this.ducked ? this.level : 1;
        const p = g.gain.gain;
        if (Math.abs(p.value - want) > 0.02 && !this.ramping(g)) p.setTargetAtTime(want, g.ctx.currentTime, 0.05);
        return;
      }
      if (this.ducked && this.useGain && !this.gainFailed) { this.apply(150); return; } // контекст міг запрацювати
      if (this.base == null || this.lastSet == null) return;
      if (Math.abs(v.volume - this.lastSet) > 0.015) {
        // гучність змінив плеєр або користувач — приймаємо її як нову базову
        this.base = v.volume;
        clearInterval(this.fadeTimer);
        if (this.ducked) { v.volume = this.base * this.level; this.lastSet = v.volume; }
        else { this.base = null; this.lastSet = null; }
      }
    }
    ramping(g) {
      return g.lastRampEnd && g.ctx.currentTime < g.lastRampEnd;
    }
    release() {
      clearInterval(this.fadeTimer);
      const v = this.video;
      if (v) {
        const g = graphs.get(v);
        if (g) { try { g.gain.gain.cancelScheduledValues(0); g.gain.gain.value = 1; } catch (_) { /* ignore */ } }
        else if (this.base != null) v.volume = this.base;
      }
      this.ducked = false;
      this.base = null;
      this.lastSet = null;
      this.video = null;
    }
  }

  // ---------------- Контролер синхронізації ----------------

  const CHARS_PER_SEC = 14; // орієнтовна швидкість української мови при rate = 1
  const MAX_LAG_MS = 4000;
  const LEAD_MS = 150;

  class Controller {
    constructor(hooks) {
      this.hooks = Object.assign({ isBlocked: () => false, overlayParent: () => null, fixedOverlay: false }, hooks || {});
      this.settings = Object.assign({}, globalThis.UAV_DEFAULTS || {});
      this.speaker = new Speaker();
      this.overlay = new Overlay();
      this.video = null;
      this.phrases = [];
      this.trCache = new Map();
      this.idx = 0;
      this.active = false;
      this.speaking = false;
      this.gen = 0;
      this.status = 'Очікування відео';
      this.needsTr = false;
      this.meta = {};
      this.trBusy = false;
      this.trPauseUntil = 0;
      this.trFailures = 0;
      this.ducker = new Ducker(!!this.hooks.useGain);
      this.ducker.setLevel(this.settings.duck);
      this.unduckTimer = null;
      this.lastT = null;
      this.timer = null;
      this.onVideoEvent = this.onVideoEvent.bind(this);
    }

    setSettings(s) {
      this.settings = Object.assign({}, this.settings, s);
      this.ducker.setLevel(this.settings.duck);
      if (!this.settings.overlay) this.overlay.hide(0);
    }
    setStatus(s) { this.status = s; }

    attachVideo(v) {
      if (this.video === v) return;
      this.detachVideo();
      this.video = v;
      this.ducker.attach(v);
      if (!v) return;
      ['seeked', 'pause', 'play', 'emptied'].forEach(e => v.addEventListener(e, this.onVideoEvent));
    }
    detachVideo() {
      if (!this.video) return;
      this.ducker.release();
      ['seeked', 'pause', 'play', 'emptied'].forEach(e => this.video.removeEventListener(e, this.onVideoEvent));
      this.video = null;
    }

    onVideoEvent(e) {
      if (!this.active) return;
      if (e.type === 'seeked' || e.type === 'play') this.resync();
      else if (e.type === 'pause' || e.type === 'emptied') this.interrupt();
    }

    // phrases: [{start,end,text}] ; meta: {needsTranslation, label, title}
    load(phrases, meta) {
      this.gen++;
      this.interrupt();
      this.meta = meta || {};
      this.needsTr = !!this.meta.needsTranslation;
      this.trFailures = 0;
      this.trBusy = false;
      this.trPauseUntil = 0;
      this.phrases = phrases.map(p => Object.assign({}, p, { tr: this.needsTr ? this.trCache.get(p.text) : p.text }));
      this.idx = 0;
      this.lastT = null;
      this.resync();
      this.setStatus(`${this.meta.label || 'Субтитри'} · фраз: ${this.phrases.length}`);
    }

    // м'яке оновлення (нові репліки довантажились) без переривання голосу
    update(phrases) {
      const t = this.video ? this.video.currentTime * 1000 : 0;
      this.phrases = phrases.map(p => Object.assign({}, p, { tr: this.needsTr ? this.trCache.get(p.text) : p.text }));
      this.idx = this.firstIndexAfter(t);
      this.setStatus(`${this.meta.label || 'Субтитри'} · фраз: ${this.phrases.length}`);
    }

    clear(status) {
      this.gen++;
      this.interrupt();
      this.phrases = [];
      this.idx = 0;
      if (status) this.setStatus(status);
    }

    start() {
      if (this.active) return;
      this.active = true;
      this.resync();
      this.timer = setInterval(() => this.tick(), 120);
    }
    stop(status) {
      this.active = false;
      clearInterval(this.timer);
      this.timer = null;
      this.interrupt();
      if (status) this.setStatus(status);
    }
    destroy() { this.stop(); this.detachVideo(); this.overlay.remove(); }

    firstIndexAfter(t) {
      const P = this.phrases;
      let i = 0;
      while (i < P.length && P[i].end <= t + 200) i++;
      return i;
    }
    resync() {
      this.interrupt();
      const t = this.video ? this.video.currentTime * 1000 : 0;
      this.idx = this.firstIndexAfter(t);
      this.lastT = t;
    }

    interrupt() {
      if (this.speaking || this.speaker.pending.size) this.speaker.stop();
      this.speaking = false;
      this.overlay.hide(0);
      this.unduck(true);
    }

    textFor(p) {
      if (!this.needsTr) return p.text;
      return typeof p.tr === 'string' ? p.tr : null;
    }

    tick() {
      try { this.tickInner(); } catch (e) {
        if (String(e).includes('Extension context invalidated')) this.destroy();
      }
    }

    tickInner() {
      const v = this.video;
      if (!this.active || !v) return;
      if (this.settings.overlay && this.hooks.fixedOverlay) this.overlay.placeOver(v.getBoundingClientRect());
      this.ducker.enforce();
      if (v.paused || v.ended || this.hooks.isBlocked()) { if (this.speaking) this.interrupt(); return; }
      const t = v.currentTime * 1000;
      if (this.lastT != null && (t < this.lastT - 800 || t > this.lastT + 3000)) this.resync();
      this.lastT = t;
      if (this.needsTr) this.ensureTranslated(this.idx);
      if (this.speaking) return;

      const P = this.phrases;
      while (this.idx < P.length) {
        const p = P[this.idx];
        if (p.start > t + LEAD_MS) break;
        const late = t - p.start;
        if (late > MAX_LAG_MS && p.end < t) { this.idx++; continue; }
        const text = this.textFor(p);
        if (text === null) {             // переклад ще не готовий
          if (late > MAX_LAG_MS) { this.idx++; continue; }
          return;
        }
        if (!text.trim()) { this.idx++; continue; }
        this.say(this.idx, text, t);
        this.idx++;
        break;
      }
    }

    say(i, text, t) {
      const s = this.settings;
      const P = this.phrases;
      const p = P[i];
      const next = P[i + 1];
      const vr = (this.video && this.video.playbackRate) || 1;
      const windowMs = Math.max(700, ((next ? next.start : p.end + 1200) - t) / vr);
      const base = Number(s.rate) || 1;
      let rate = base;
      if (s.adaptive) {
        const needMs = text.length / CHARS_PER_SEC * 1000 / base;
        const k = needMs / windowMs;
        if (k > 1) rate = Math.min(base * k, Math.max(base, Number(s.maxRate) || 1.7));
      }
      rate = Math.round(rate * 100) / 100;

      const gen = this.gen;
      this.speaking = true;
      if (s.overlay) {
        this.overlay.mount(this.hooks.overlayParent(), this.hooks.fixedOverlay);
        this.overlay.show(text);
      }
      this.duck();

      // попередньо готуємо аудіо наступних фраз (для онлайн-голосу)
      const ahead = [];
      for (let k = i + 1; k < Math.min(P.length, i + 3); k++) {
        const tx = this.textFor(P[k]);
        if (tx) ahead.push(tx);
      }
      if (ahead.length) this.speaker.prefetch(ahead);

      this.speaker.speak(text, { rate, volume: Number(s.volume) }).then(res => {
        if (gen !== this.gen) return;
        this.speaking = false;
        this.overlay.hide(350);
        clearTimeout(this.unduckTimer);
        this.unduckTimer = setTimeout(() => { if (!this.speaking) this.unduck(); }, 450);
        if (res && res.status === 'error') this.setStatus('Помилка голосу: ' + (res.error || 'невідома'));
      });
    }

    // --- приглушення оригіналу ---
    duck() { clearTimeout(this.unduckTimer); this.ducker.duck(); }
    unduck(immediate) { clearTimeout(this.unduckTimer); this.ducker.unduck(immediate); }

    // --- переклад пакетами наперед (≈3 хв) ---
    async ensureTranslated(from) {
      if (this.trBusy || Date.now() < this.trPauseUntil) return;
      const P = this.phrases;
      if (!P.length) return;
      const horizon = (P[Math.min(from, P.length - 1)] || {}).start + 180000;
      const batch = [];
      let chars = 0;
      for (let i = Math.max(0, from - 1); i < P.length && batch.length < 30; i++) {
        if (P[i].tr !== undefined) { if (batch.length) break; continue; }
        if (P[i].start > horizon) break;
        if (batch.length && chars + P[i].text.length > 3500) break;
        batch.push(i);
        chars += P[i].text.length;
      }
      if (!batch.length) return;
      const gen = this.gen;
      this.trBusy = true;
      batch.forEach(i => { P[i].tr = null; });
      try {
        const res = await chrome.runtime.sendMessage({
          type: 'translate',
          texts: batch.map(i => P[i].text),
          title: this.meta.title || ''
        });
        if (gen !== this.gen) return;
        if (res && res.ok && Array.isArray(res.texts)) {
          this.trFailures = 0;
          batch.forEach((i, k) => {
            const tr = String(res.texts[k] || '').trim();
            P[i].tr = tr;
            this.trCache.set(P[i].text, tr);
          });
          this.setStatus(res.note || `${this.meta.label || 'Переклад'} · фраз: ${P.length}`);
        } else {
          throw new Error((res && res.error) || 'немає відповіді від фонового модуля');
        }
      } catch (e) {
        if (gen !== this.gen) return;
        const msg = String(e && e.message || e);
        console.warn('[Закадровий UA] переклад:', msg);
        batch.forEach(i => { P[i].tr = undefined; });
        this.trFailures++;
        this.trPauseUntil = Date.now() + 3000;
        this.setStatus('Помилка перекладу: ' + msg);
        if (this.trFailures >= 2 && this.hooks.onTranslateFailure) this.hooks.onTranslateFailure(msg);
      } finally {
        this.trBusy = false;
      }
    }
  }

  async function getSettings() {
    try { return await uavGetSettings(false); } catch (_) { return Object.assign({}, globalThis.UAV_DEFAULTS || {}); }
  }

  globalThis.UAVoice = { cleanText, parseJson3, buildPhrases, Controller, Speaker, Overlay, Ducker, getSettings };
})();
