import type { StorybookConfig } from '@storybook/react-vite';
import { resolve } from 'node:path';

const config: StorybookConfig = {
  stories: ['../src/**/*.stories.@(ts|tsx)'],
  addons: [
    '@storybook/addon-essentials',
    '@storybook/addon-a11y',
  ],
  framework: {
    name: '@storybook/react-vite',
    options: {},
  },
  viteFinal: async (viteConfig) => {
    // Path alias — preserve any existing alias config (object or array form).
    const aliasEntry = { '@': resolve(import.meta.dirname, '../src') };
    if (!viteConfig.resolve) {
      viteConfig.resolve = { alias: aliasEntry };
    } else if (Array.isArray(viteConfig.resolve.alias)) {
      viteConfig.resolve.alias = [
        ...viteConfig.resolve.alias,
        { find: '@', replacement: aliasEntry['@'] },
      ];
    } else {
      viteConfig.resolve.alias = {
        ...viteConfig.resolve.alias,
        ...aliasEntry,
      };
    }
    // Build-time flag read by main.tsx fixture guard (AC-8).
    viteConfig.define = {
      ...viteConfig.define,
      'import.meta.env.STORYBOOK': JSON.stringify(true),
    };
    return viteConfig;
  },
};

export default config;
