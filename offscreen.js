// Прихований документ розширення: відтворює mp3-фрагменти онлайн-голосу
// (не залежить від політик безпеки сторінки, на якій грає відео).
let audio = null;
let queue = [];
let curId = null;
let rate = 1;
let volume = 1;

function finish(status, error) {
  const id = curId;
  curId = null;
  audio = null;
  queue = [];
  if (id != null) chrome.runtime.sendMessage({ from: 'offscreen', type: 'ended', id, status, error }).catch(() => {});
}

function next() {
  if (curId == null) return;
  if (!queue.length) { finish('end'); return; }
  const a = new Audio('data:audio/mpeg;base64,' + queue.shift());
  a.defaultPlaybackRate = rate;
  a.playbackRate = rate;
  a.preservesPitch = true;
  a.volume = volume;
  a.onended = next;
  a.onerror = () => finish('error', 'Не вдалося відтворити аудіо');
  audio = a;
  a.play().then(() => { a.playbackRate = rate; }).catch(e => finish('error', String(e)));
}

function stop() {
  if (audio) { audio.onended = null; audio.onerror = null; audio.pause(); }
  audio = null;
  queue = [];
  curId = null;
}

chrome.runtime.onMessage.addListener((m, sender, sendResponse) => {
  if (!m || m.target !== 'offscreen') return;
  if (m.type === 'play') {
    stop();
    curId = m.id;
    queue = (m.chunks || []).slice();
    rate = m.rate || 1;
    volume = m.volume == null ? 1 : m.volume;
    next();
  } else if (m.type === 'stop') {
    stop();
  }
  sendResponse({ ok: true });
});
