import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'YouTube 双语字幕',
    description: '英文视频的中英双语字幕，大模型驱动，面向中文学习者',
    permissions: ['storage', 'unlimitedStorage'],
    host_permissions: [
      'https://www.youtube.com/*',
      'https://api.anthropic.com/*',
    ],
    // OpenAI 兼容供应商的地址由用户在设置页填写，运行时按需申请权限
    optional_host_permissions: ['https://*/*'],
    options_ui: {
      open_in_tab: true,
    },
  },
});
