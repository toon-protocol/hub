import { createElement } from 'react';
import { render, type Instance } from 'ink';
import App from './App.js';

export interface MountTuiOptions {
  apiUrl?: string;
  refreshIntervalMs?: number;
  fetchImpl?: typeof fetch;
}

export function mountTui(opts: MountTuiOptions = {}): Instance {
  return render(createElement(App, opts), {
    exitOnCtrlC: true,
    patchConsole: false,
  });
}
