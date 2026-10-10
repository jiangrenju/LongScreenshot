export const DEFAULT_SETTINGS = {
  // 每次滚动后等待页面渲染 / 懒加载的时间（毫秒）
  delay: 450,
  // original: 按屏幕物理像素输出（Retina 屏为 2 倍）；1x: 按 CSS 像素输出
  quality: 'original',
  // 滚动过程中隐藏 fixed 元素、将 sticky 元素还原为普通流，避免重复出现在长图中
  hideFixed: true,
};
