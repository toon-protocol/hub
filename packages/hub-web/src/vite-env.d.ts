/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Set to true by .storybook/main.ts viteFinal — used by main.tsx fixture guard (AC-8). */
  readonly STORYBOOK?: boolean;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
