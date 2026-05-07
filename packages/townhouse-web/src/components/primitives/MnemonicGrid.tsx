import * as React from 'react';

export interface MnemonicGridProps {
  words: string[];
  ariaLabel?: string;
}

/**
 * Numbered mnemonic grid — renders words in a 4-column layout.
 * Extracted from RevealSeedModal for reuse in the first-run wizard.
 */
export function MnemonicGrid({ words, ariaLabel }: MnemonicGridProps) {
  return (
    <ol
      aria-label={ariaLabel ?? 'Recovery seed phrase'}
      className="grid grid-cols-4 gap-2"
    >
      {words.map((word, i) => (
        <li key={i} className="flex items-baseline gap-1">
          <span className="font-geist-mono text-xs text-ink/40 tabular-nums">{i + 1}.</span>
          <span className="font-geist-mono text-sm text-ink">{word}</span>
        </li>
      ))}
    </ol>
  );
}
