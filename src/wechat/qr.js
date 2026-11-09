'use strict';
/**
 * 二维码 → SVG（服务端渲染，供扫码绑定页展示）。
 * 使用 vendored 的 qrcode-generator（MIT, Kazuhiko Arase），见 vendor/qrcode.js。
 */
const qrcodeFactory = require('./vendor/qrcode');

/**
 * 把文本渲染成 SVG 字符串（含白底与静区）。
 * @param {string} content 二维码内容（iLink 绑定二维码通常是 https://weixin.qq.com/x/... 链接）
 * @param {number} sizePx 期望显示尺寸
 */
function qrcodeSvg(content, sizePx = 260) {
  const text = String(content || '');
  if (!text) return '';
  const qr = qrcodeFactory(0, 'M'); // 0 = 自动选择版本
  qr.addData(text, 'Byte');
  qr.make();
  const count = qr.getModuleCount();
  const quiet = 2; // 静区（模块数）
  const modules = count + quiet * 2;
  const cell = Math.max(1, Math.floor(sizePx / modules));
  const width = modules * cell;

  // 用横向游程压缩成 <path>
  const runs = [];
  for (let row = 0; row < modules; row++) {
    let col = 0;
    while (col < modules) {
      const isDark = col >= quiet && col < count + quiet && row >= quiet && row < count + quiet && qr.isDark(row - quiet, col - quiet);
      if (!isDark) { col++; continue; }
      let end = col + 1;
      while (end < modules) {
        const dark = end >= quiet && end < count + quiet && row >= quiet && row < count + quiet && qr.isDark(row - quiet, end - quiet);
        if (!dark) break;
        end++;
      }
      runs.push(`M${col * cell} ${row * cell}h${(end - col) * cell}v${cell}h-${(end - col) * cell}z`);
      col = end;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${width}" width="${sizePx}" height="${sizePx}" shape-rendering="crispEdges"><rect width="${width}" height="${width}" fill="#ffffff"/><path d="${runs.join('')}" fill="#111111"/></svg>`;
}

module.exports = { qrcodeSvg };
