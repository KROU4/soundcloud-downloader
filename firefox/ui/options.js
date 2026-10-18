import { ext } from '../lib/browser.js';
import { DEFAULT_SETTINGS, SETTINGS_KEY, withDefaults } from '../lib/settings.js';

const form = document.getElementById('form');
const saved = document.getElementById('saved');

function fill(settings) {
  for (const el of form.elements) {
    if (!el.name || !(el.name in settings)) continue;
    if (el.type === 'checkbox') el.checked = !!settings[el.name];
    else el.value = settings[el.name];
  }
}

function read() {
  const out = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') out[el.name] = el.checked;
    else if (el.type === 'number') out[el.name] = Math.min(6, Math.max(1, Number(el.value) || DEFAULT_SETTINGS[el.name]));
    else out[el.name] = el.value.trim() || (el.name === 'baseFolder' ? '' : DEFAULT_SETTINGS[el.name]);
  }
  return out;
}

let savedTimer;
async function save() {
  await ext.storage.local.set({ [SETTINGS_KEY]: read() });
  saved.textContent = 'Сохранено';
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => (saved.textContent = ''), 1500);
}

form.addEventListener('change', save);
form.addEventListener('submit', (e) => e.preventDefault());
document.getElementById('reset').onclick = async () => {
  await ext.storage.local.set({ [SETTINGS_KEY]: DEFAULT_SETTINGS });
  fill(DEFAULT_SETTINGS);
  saved.textContent = 'Настройки сброшены';
};

const stored = await ext.storage.local.get(SETTINGS_KEY);
fill(withDefaults(stored[SETTINGS_KEY]));
