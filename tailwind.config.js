/** 预编译 m.html 用到的 Tailwind 工具类 → 静态 tailwind.css，替代 cdn.tailwindcss.com 运行时。
 *  重建命令: npx tailwindcss@3 -c tailwind.config.js -i tailwind.input.css -o tailwind.css --minify
 *  注意: 动态拼 class 时必须写完整类名字面量(扫描器按文本匹配,不解析 JS)。*/
module.exports = {
  content: ['./m.html'],
  theme: { extend: {} },
  plugins: [],
};
