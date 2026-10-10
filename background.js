import { DEFAULT_SETTINGS } from './common.js';
import { saveShot, pruneShots } from './db.js';

// chrome.tabs.captureVisibleTab 每秒最多调用 2 次
const CAPTURE_INTERVAL = 520;
// 单张画布的尺寸上限，超出后自动拆分为多张图片
const MAX_CANVAS_SIDE = 32000;
const MAX_CANVAS_AREA = 100_000_000;
const KEEP_SHOTS = 10;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** tabId -> 截图会话 */
const sessions = new Map();
let lastCaptureAt = 0;

function isRestricted(url = '') {
  return (
    /^(chrome|chrome-extension|chrome-search|chrome-untrusted|edge|about|devtools|view-source):/i.test(url) ||
    /^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com)/i.test(url)
  );
}

function friendlyError(err) {
  const msg = err?.message || String(err);
  if (/file:\/\//i.test(msg)) return new Error('截取本地文件需要在扩展详情页开启「允许访问文件网址」');
  if (/activeTab|all_urls|Cannot access|cannot be scripted/i.test(msg)) {
    return new Error('没有该页面的截图权限，请刷新页面后通过扩展图标或快捷键重新启动');
  }
  return err instanceof Error ? err : new Error(msg);
}

async function startCapture(tabId, mode) {
  const tab = await chrome.tabs.get(tabId);
  if (isRestricted(tab.url)) throw new Error('浏览器内置页面和扩展商店页面不允许截图');
  const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (m, s) => window.__scrollShot.start(m, s),
      args: [mode, settings],
    });
    if (res?.result?.error) throw new Error(res.result.error);
  } catch (err) {
    throw friendlyError(err);
  }
}

async function captureTab(windowId) {
  for (let attempt = 0; ; attempt++) {
    const wait = lastCaptureAt + CAPTURE_INTERVAL - Date.now();
    if (wait > 0) await sleep(wait);
    lastCaptureAt = Date.now();
    try {
      return await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    } catch (err) {
      if (attempt < 2 && /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/.test(err?.message)) {
        await sleep(600);
        continue;
      }
      throw friendlyError(err);
    }
  }
}

/** 从整屏截图中裁出本次新增的条带，缩放到输出倍率后存为 PNG Blob。 */
async function cropFrame(s, dataUrl, msg) {
  const frame = await createImageBitmap(await (await fetch(dataUrl)).blob());
  try {
    const k = frame.width / msg.viewportWidth; // 截图像素 / CSS 像素
    const out = s.quality === '1x' ? 1 : k;
    if (!s.width) {
      s.width = Math.max(1, Math.round(msg.crop.width * out));
      s.cssWidth = Math.round(msg.crop.width);
    }

    const { crop } = msg;
    const dy = Math.round(msg.docStart * out);
    const dh = Math.round(msg.docEnd * out) - dy;
    const sx = Math.round(crop.left * k);
    let sy = Math.round(crop.top * k);
    let sw = Math.round((crop.left + crop.width) * k) - sx;
    let sh = Math.round((crop.top + crop.height) * k) - sy;
    if (out === k) {
      // 原始倍率下 1:1 拷贝像素，避免因取整产生 1px 缩放而模糊
      sw = s.width;
      sh = dh;
      sy = Math.min(sy, frame.height - sh);
    }
    if (sw < 1 || sh < 1 || dh < 1) return;

    const canvas = new OffscreenCanvas(s.width, dh);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = out !== k;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(frame, sx, sy, sw, sh, 0, 0, s.width, dh);
    s.strips.push({ dy, dh, blob: await canvas.convertToBlob({ type: 'image/png' }) });
    s.height = Math.max(s.height, dy + dh);
  } finally {
    frame.close();
  }
}

async function compose({ strips, width, height }) {
  const maxChunk = Math.max(2000, Math.min(MAX_CANVAS_SIDE, Math.floor(MAX_CANVAS_AREA / width)));
  const chunk = Math.ceil(height / Math.ceil(height / maxChunk));
  const parts = [];
  for (let y0 = 0; y0 < height; y0 += chunk) {
    const h = Math.min(chunk, height - y0);
    const canvas = new OffscreenCanvas(width, h);
    const ctx = canvas.getContext('2d');
    for (const st of strips) {
      if (st.dy + st.dh <= y0 || st.dy >= y0 + h) continue;
      const bmp = await createImageBitmap(st.blob);
      ctx.drawImage(bmp, 0, st.dy - y0);
      bmp.close();
    }
    parts.push(await canvas.convertToBlob({ type: 'image/png' }));
  }
  return parts;
}

const handlers = {
  // 来自弹出窗口
  'ss-start': (msg) => startCapture(msg.tabId, msg.mode),

  // 以下来自内容脚本
  'ss-begin': (msg, sender) => {
    sessions.set(sender.tab.id, {
      title: msg.title,
      url: msg.url,
      quality: msg.quality,
      strips: [],
      jobs: [],
      width: 0,
      height: 0,
    });
  },

  'ss-capture': async (msg, sender) => {
    const tabId = sender.tab.id;
    const s = sessions.get(tabId);
    if (!s) throw new Error('截图会话已失效，请重新开始');
    const tab = await chrome.tabs.get(tabId);
    if (!tab.active) throw new Error('截图过程中请保持该标签页在前台');
    const dataUrl = await captureTab(tab.windowId);
    // 裁剪在后台进行，内容脚本可以立即滚动到下一屏
    const job = cropFrame(s, dataUrl, msg);
    job.catch(() => {}); // 错误在 ss-finish 中统一抛出
    s.jobs.push(job);
  },

  'ss-finish': async (msg, sender) => {
    const tab = sender.tab;
    const s = sessions.get(tab.id);
    if (!s) throw new Error('截图会话已失效，请重新开始');
    sessions.delete(tab.id);
    await Promise.all(s.jobs);
    if (!s.strips.length) throw new Error('没有截取到任何画面');

    const parts = await compose(s);
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    await saveShot({
      id,
      createdAt: Date.now(),
      title: s.title,
      url: s.url,
      width: s.width,
      height: s.height,
      cssWidth: s.cssWidth,
      truncated: !!msg.truncated,
      parts,
    });
    pruneShots(KEEP_SHOTS).catch(() => {});
    await chrome.tabs.create({
      url: chrome.runtime.getURL(`result.html#${id}`),
      index: tab.index + 1,
      openerTabId: tab.id,
    });
  },

  'ss-cancel': (msg, sender) => {
    sessions.delete(sender.tab.id);
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = handlers[msg?.type];
  if (!handler) return false;
  Promise.resolve()
    .then(() => handler(msg, sender))
    .then(
      (res) => sendResponse({ ok: true, ...res }),
      (err) => sendResponse({ ok: false, error: err?.message || String(err) }),
    );
  return true;
});

function flashBadge(tabId, message) {
  chrome.action.setBadgeBackgroundColor({ color: '#dc2626' });
  chrome.action.setBadgeText({ tabId, text: '!' });
  chrome.action.setTitle({ tabId, title: `滚动长截图：${message}` });
  setTimeout(() => {
    chrome.action.setBadgeText({ tabId, text: '' });
    chrome.action.setTitle({ tabId, title: '滚动长截图' });
  }, 5000);
}

chrome.commands.onCommand.addListener((command, tab) => {
  const mode = { 'capture-full': 'full', 'capture-region': 'region' }[command];
  if (!mode || !tab?.id) return;
  startCapture(tab.id, mode).catch((err) => flashBadge(tab.id, err.message));
});

chrome.tabs.onRemoved.addListener((tabId) => sessions.delete(tabId));
