// Спільні налаштування для background, popup і content-скриптів.
/* exported UAV_DEFAULTS, UAV_SECRET_DEFAULTS, uavGetSettings */

var UAV_DEFAULTS = {
  enabled: true,          // автоматично озвучувати відео на YouTube
  mode: 'youtube',        // 'youtube' — автопереклад субтитрів YouTube; 'translate' — власний переклад
  translator: 'google',   // 'google' | 'deepl' | 'claude'
  voiceEngine: 'auto',    // 'auto' | 'system' | 'google'
  voiceName: '',          // назва системного голосу (порожньо — перший український)
  rate: 1.1,              // базова швидкість мовлення
  maxRate: 1.7,           // межа прискорення, коли голос не встигає
  adaptive: true,         // підлаштовувати швидкість під тривалість фрази
  volume: 1.0,            // гучність голосу
  duck: 0.25,             // гучність оригіналу під час мовлення (0..1)
  overlay: true,          // показувати текст, що озвучується
  claudeModel: 'claude-haiku-5-5'
};

var UAV_SECRET_DEFAULTS = { deeplKey: '', claudeKey: '' };

async function uavGetSettings(withSecrets) {
  const s = await chrome.storage.sync.get(UAV_DEFAULTS);
  if (!withSecrets) return s;
  const k = await chrome.storage.local.get(UAV_SECRET_DEFAULTS);
  return Object.assign({}, s, k);
}
