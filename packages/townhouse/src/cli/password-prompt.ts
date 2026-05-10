/**
 * Interactive password prompt using `node:readline` with character masking.
 * Used by `townhouse hs up` when neither --password flag nor
 * TOWNHOUSE_WALLET_PASSWORD env var is set and stdin is a TTY (Story 45.4).
 *
 * No external dependencies — uses only Node built-ins per architecture rules.
 */

import { createInterface } from 'node:readline';

/**
 * Prompt for a password interactively. Masks each typed character with '*'.
 * The mute trick overrides `_writeToOutput` on the Interface instance so
 * every character echo is replaced with `*`.
 *
 * @returns The entered password string (without trailing newline).
 * @throws Never — on I/O errors the returned promise rejects.
 */
export function promptPassword(prompt = 'Wallet password: '): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });

    // Intercept all output from readline and replace with '*' per character.
    // Casting needed: _writeToOutput is a protected internal implementation
    // detail, not in the public Node.js type definitions.
    const iface = rl as unknown as {
      _writeToOutput: (str: string) => void;
      output: NodeJS.WritableStream;
    };

    const origWrite = iface._writeToOutput.bind(iface);
    iface._writeToOutput = (str: string) => {
      // Pass through control sequences (cursor movement, newlines) but mask
      // printable characters.
      if (str === '\r\n' || str === '\n' || str === '\r') {
        // Let the newline through so the cursor advances.
        origWrite(str);
      } else if (/^[\x20-\x7e-￿]/.test(str)) {
        // Printable character — mask with '*'.
        origWrite('*'.repeat(str.length));
      } else {
        // Control sequence — pass through unchanged.
        origWrite(str);
      }
    };

    rl.question(prompt, (answer) => {
      // Restore original writer before closing so subsequent console.log
      // calls are not masked.
      iface._writeToOutput = origWrite;
      // Emit a newline so the terminal cursor lands on the next line.
      process.stdout.write('\n');
      rl.close();
      resolve(answer);
    });

    rl.once('error', (err) => {
      iface._writeToOutput = origWrite;
      rl.close();
      reject(err);
    });

    rl.once('close', () => {
      // No-op: resolved above or rejected above.
    });
  });
}
