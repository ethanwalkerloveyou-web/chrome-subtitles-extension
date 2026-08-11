import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: '双语视频字幕',
    description:
      'YouTube / X 英文视频的中英双语字幕，大模型驱动，面向中文学习者',
    permissions: ['storage', 'unlimitedStorage'],
    host_permissions: [
      'https://www.youtube.com/*',
      'https://x.com/*',
      'https://twitter.com/*',
      'https://*.twimg.com/*',
      'https://api.anthropic.com/*',
    ],
    // OpenAI 兼容供应商的地址由用户在设置页填写，运行时按需申请权限
    optional_host_permissions: ['https://*/*'],
    // main-world.js 是要注入到页面自己 JS 环境里执行的，
    // 页面必须能加载它 —— 不声明这一条，注入会静默失败。
    web_accessible_resources: [
      {
        resources: ['main-world.js'],
        matches: [
          'https://www.youtube.com/*',
          'https://x.com/*',
          'https://twitter.com/*',
        ],
      },
    ],
  },
});
