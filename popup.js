import { DEFAULT_SETTINGS } from './common.js';

const $ = (sel) => document.querySelector(sel);
const errorBox = $('#error');

async function initSettings() {
  const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  const delay = $('#delay');
  const quality = $('#quality');
  const hideFixed = $('#hideFixed');

  delay.value = String(settings.delay);
  if (!delay.value) delay.value = String(DEFAULT_SETTINGS.delay);
  quality.value = settings.quality;
  hideFixed.checked = settings.hideFixed;

  delay.addEventListener('change', () => chrome.storage.sync.set({ delay: Number(delay.value) }));
  quality.addEventListener('change', () => chrome.storage.sync.set({ quality: quality.value }));
  hideFixed.addEventListener('change', () => chrome.storage.sync.set({ hideFixed: hideFixed.checked }));
}

async function initShortcuts() {
  const commands = await chrome.commands.getAll();
  for (const cmd of commands) {
    const kbd = document.querySelector(`kbd[data-command="${cmd.name}"]`);
    if (kbd) kbd.textContent = cmd.shortcut || '';
  }
}

async function start(mode) {
  const buttons = document.querySelectorAll('.mode');
  buttons.forEach((b) => (b.disabled = true));
  errorBox.hidden = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) throw new Error('找不到当前标签页');
    const res = await chrome.runtime.sendMessage({ type: 'ss-start', mode, tabId: tab.id });
    if (!res?.ok) throw new Error(res?.error || '启动失败');
    window.close();
  } catch (err) {
    errorBox.textContent = err.message || String(err);
    errorBox.hidden = false;
    buttons.forEach((b) => (b.disabled = false));
  }
}

document.querySelectorAll('.mode').forEach((btn) => btn.addEventListener('click', () => start(btn.dataset.mode)));
initSettings();
initShortcuts();
