/**
 * Cross-platform browser opener for the wizard CLI command.
 * Uses platform-native launchers; errors are non-fatal.
 */

import { spawn } from 'node:child_process';

export interface BrowserOpener {
  open(url: string): Promise<void>;
}

export class RealBrowserOpener implements BrowserOpener {
  async open(url: string): Promise<void> {
    let cmd: string;
    let args: string[];

    switch (process.platform) {
      case 'darwin':
        cmd = 'open';
        args = [url];
        break;
      case 'win32':
        cmd = 'cmd';
        args = ['/c', 'start', '', url];
        break;
      default:
        cmd = 'xdg-open';
        args = [url];
        break;
    }

    return new Promise<void>((resolve) => {
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        resolve();
      };

      try {
        const child = spawn(cmd, args, {
          stdio: ['ignore', 'ignore', 'ignore'],
          detached: true,
        });

        // ENOENT (e.g. xdg-open not on PATH on a minimal container/WSL2 env)
        // surfaces asynchronously via the 'error' event, NOT a synchronous
        // throw from spawn. Subscribe so we don't crash with an unhandled
        // 'error' event and so the user gets a hint about why no browser opened.
        child.once('error', (err: Error) => {
          console.warn(`[Townhouse] Could not open browser via ${cmd}: ${err.message}`);
          settle();
        });
        child.once('spawn', () => {
          child.unref();
          settle();
        });
      } catch (err: unknown) {
        // Synchronous spawn error path (rare)
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[Townhouse] Could not open browser: ${msg}`);
        settle();
      }
    });
  }
}

export class NoopBrowserOpener implements BrowserOpener {
  public readonly calls: string[] = [];

  async open(url: string): Promise<void> {
    this.calls.push(url);
  }
}
