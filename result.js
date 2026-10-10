import { getShot } from './db.js';

const $ = (sel) => document.querySelector(sel);
const stage = $('#stage');

function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.hidden = true), 2200);
}

const pad = (n) => String(n).padStart(2, '0');

function baseName(shot) {
  const d = new Date(shot.createdAt);
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  let host = '';
  try {
    host = new URL(shot.url).hostname.replace(/^www\./, '');
  } catch {}
  return ['长截图', host, stamp].filter(Boolean).join('_');
}

function formatSize(bytes) {
  return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

function download(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
}

async function main() {
  const shot = await getShot(location.hash.slice(1));
  if (!shot) {
    stage.innerHTML = '<p class="empty">截图不存在或已过期（仅保留最近 10 次截图）</p>';
    document.querySelectorAll('.actions button').forEach((b) => (b.disabled = true));
    return;
  }

  const { parts } = shot;
  const urls = parts.map((blob) => URL.createObjectURL(blob));
  const name = baseName(shot);
  const bytes = parts.reduce((sum, b) => sum + b.size, 0);

  document.title = `长截图 - ${shot.title || shot.url}`;
  $('#title').textContent = shot.title || '长截图';
  const meta = $('#meta');
  meta.textContent = `${shot.width} × ${shot.height} px · ${formatSize(bytes)} · `;
  const link = Object.assign(document.createElement('a'), { href: shot.url, target: '_blank', rel: 'noreferrer', textContent: shot.url });
  meta.append(link);

  const notices = [];
  if (parts.length > 1) notices.push(`图片过长，已按顺序拆分为 ${parts.length} 张保存。`);
  if (shot.truncated) notices.push('已达到最大截图长度，超出部分未截取。');
  if (notices.length) {
    $('#notice').textContent = notices.join(' ');
    $('#notice').hidden = false;
  }

  // 多张图片之间无缝拼接显示
  const sheet = document.createElement('div');
  sheet.className = 'sheet';
  for (const url of urls) {
    const img = new Image();
    img.src = url;
    img.alt = '';
    img.style.setProperty('--css-width', `${shot.cssWidth || shot.width}px`);
    sheet.append(img);
  }
  stage.append(sheet);

  $('#download').addEventListener('click', () => {
    urls.forEach((url, i) => download(url, parts.length > 1 ? `${name}_${i + 1}.png` : `${name}.png`));
  });

  const copyBtn = $('#copy');
  if (parts.length > 1) {
    copyBtn.disabled = true;
    copyBtn.title = '图片已拆分为多张，请使用下载';
  }
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': parts[0] })]);
      toast('已复制到剪贴板');
    } catch (err) {
      toast(`复制失败：${err.message}`);
    }
  });

  const zoomBtn = $('#zoom');
  zoomBtn.addEventListener('click', () => {
    const actual = stage.classList.toggle('actual');
    stage.classList.toggle('fit', !actual);
    zoomBtn.textContent = actual ? '适应窗口' : '原始尺寸';
  });
}

main().catch((err) => {
  stage.innerHTML = '';
  const p = Object.assign(document.createElement('p'), { className: 'empty', textContent: `加载失败：${err.message}` });
  stage.append(p);
});
