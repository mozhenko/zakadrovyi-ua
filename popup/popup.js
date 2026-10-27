// Спливаюче вікно: налаштування + статус поточної вкладки.
const $ = id => document.getElementById(id);
const SYNC_FIELDS = ['translator', 'voiceEngine', 'voiceName', 'claudeModel'];
const RANGE_FIELDS = ['rate', 'volume', 'duck'];
const CHECK_FIELDS = ['enabled', 'adaptive', 'overlay'];
const SECRET_FIELDS = ['deeplKey', 'claudeKey'];

let tab = null;
let settings = null;

const fmt = {
  rate: v => '×' + Number(v).toFixed(2),
  volume: v => Math.round(v * 100) + '%',
  duck: v => Math.round(v * 100) + '%'
};

function save(obj) { return chrome.storage.sync.set(obj); }

function updateVisibility() {
  const mode = document.querySelector('input[name=mode]:checked');
  const own = mode && mode.value === 'translate';
  $('translatorRow').style.display = own ? '' : 'none';
  $('trTestRow').style.display = own ? '' : 'none';
  $('voiceRow').style.display = $('voiceEngine').value === 'google' ? 'none' : '';
}

async function loadVoices() {
  const voices = await chrome.runtime.sendMessage({ type: 'getVoices' });
  const sel = $('voiceName');
  sel.innerHTML = '';
  if (!voices || !voices.length) {
    sel.append(new Option('— немає українських голосів —', ''));
    sel.disabled = true;
    $('voiceHint').textContent = settings.voiceEngine === 'system'
      ? 'У системі не знайдено українського голосу. Оберіть «Google (онлайн)» або встановіть голос (macOS: Системні параметри → Спеціальні можливості → Озвучений вміст → Голос системи → Українська; Windows: Параметри → Час і мова → Мовлення).'
      : 'Українського системного голосу немає — використовується онлайн-голос Google.';
    return;
  }
  sel.disabled = false;
  sel.append(new Option('Перший доступний', ''));
  voices.forEach(v => sel.append(new Option(`${v.name}${v.remote ? ' (онлайн)' : ''}`, v.name)));
  sel.value = settings.voiceName || '';
  $('voiceHint').textContent = '';
}

async function refreshStatus() {
  if (!tab) return;
  const isYT = /^https:\/\/www\.youtube\.com\//.test(tab.url || '');
  let st = null;
  try { st = await chrome.tabs.sendMessage(tab.id, { type: 'uav-status' }); } catch (_) { /* немає скрипта */ }
  const dot = $('statusDot');
  dot.className = 'dot';
  if (st) {
    $('status').textContent = st.status;
    if (st.active) dot.classList.add('on');
    else if (/помилк|не вдалося|увімкніть/i.test(st.status)) dot.classList.add('warn');
    $('genericBtn').hidden = st.site === 'youtube';
    if (st.site === 'generic') {
      $('genericBtn').textContent = st.active ? 'Зупинити озвучення на цій сторінці' : 'Озвучити відео на цій сторінці';
      $('genericBtn').dataset.action = st.active ? 'stop' : 'start';
    }
  } else if (isYT) {
    $('status').textContent = settings.enabled ? 'Відкрийте відео — озвучення почнеться автоматично' : 'Озвучення вимкнено';
    $('genericBtn').hidden = true;
  } else {
    $('status').textContent = 'Для інших сайтів: увімкніть субтитри в плеєрі й натисніть кнопку нижче.';
    $('genericBtn').hidden = !/^https?:/.test(tab.url || '');
    $('genericBtn').dataset.action = 'start';
  }
}

async function init() {
  settings = await uavGetSettings(true);
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  CHECK_FIELDS.forEach(f => {
    $(f).checked = !!settings[f];
    $(f).addEventListener('change', () => { save({ [f]: $(f).checked }); setTimeout(refreshStatus, 400); });
  });
  RANGE_FIELDS.forEach(f => {
    $(f).value = settings[f];
    $(f + 'Out').textContent = fmt[f](settings[f]);
    $(f).addEventListener('input', () => { $(f + 'Out').textContent = fmt[f]($(f).value); });
    $(f).addEventListener('change', () => save({ [f]: Number($(f).value) }));
  });
  SYNC_FIELDS.forEach(f => {
    if (f === 'voiceName') return;
    $(f).value = settings[f];
    $(f).addEventListener('change', () => {
      save({ [f]: $(f).value.trim() });
      if (f === 'voiceEngine') { settings.voiceEngine = $(f).value; loadVoices(); }
      if (f === 'translator') checkKeys();
      updateVisibility();
    });
  });
  $('voiceName').addEventListener('change', () => save({ voiceName: $('voiceName').value }));

  document.querySelectorAll('input[name=mode]').forEach(r => {
    r.checked = r.value === settings.mode;
    r.addEventListener('change', () => { save({ mode: r.value }); updateVisibility(); setTimeout(refreshStatus, 800); });
  });

  SECRET_FIELDS.forEach(f => {
    $(f).value = settings[f] || '';
    $(f).addEventListener('change', () => chrome.storage.local.set({ [f]: $(f).value.trim() }));
  });

  $('testBtn').addEventListener('click', () => chrome.runtime.sendMessage({
    type: 'testVoice',
    text: 'Добрий день! Так звучатиме український закадровий переклад.',
    rate: Number($('rate').value),
    volume: Number($('volume').value)
  }));

  $('trTestBtn').addEventListener('click', async () => {
    const out = $('trTestOut');
    out.textContent = 'Перевіряю…';
    const res = await chrome.runtime.sendMessage({ type: 'testTranslate' });
    out.textContent = res && res.ok
      ? '✓ ' + res.texts.join(' ') + (res.note ? ' (' + res.note + ')' : '')
      : '✗ ' + ((res && res.error) || 'немає відповіді');
  });

  $('genericBtn').addEventListener('click', async () => {
    if ($('genericBtn').dataset.action === 'stop') {
      try { await chrome.tabs.sendMessage(tab.id, { type: 'uav-generic-stop' }); } catch (_) { /* ignore */ }
    } else {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['shared/settings.js', 'content/core.js', 'content/generic.js']
        });
      } catch (e) {
        $('status').textContent = 'Не вдалося запустити на цій сторінці: ' + e.message;
        return;
      }
    }
    setTimeout(refreshStatus, 1500);
  });

  updateVisibility();
  checkKeys();
  await loadVoices();
  refreshStatus();
  setInterval(refreshStatus, 2000);
}

function checkKeys() {
  const t = $('translator').value;
  if ((t === 'deepl' && !$('deeplKey').value) || (t === 'claude' && !$('claudeKey').value)) $('keys').open = true;
}

init();
