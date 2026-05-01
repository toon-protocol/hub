import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { axe } from '../../test-setup';
import { MnemonicGrid } from './MnemonicGrid';

const TWELVE_WORDS = Array.from({ length: 12 }, (_, i) => `word${i + 1}`);
const TWENTY_FOUR_WORDS = Array.from({ length: 24 }, (_, i) => `word${i + 1}`);

describe('MnemonicGrid', () => {
  it('renders 12 words with numbering', () => {
    render(<MnemonicGrid words={TWELVE_WORDS} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(12);
    expect(screen.getByText('word1')).toBeInTheDocument();
    expect(screen.getByText('word12')).toBeInTheDocument();
    expect(screen.getByText('1.')).toBeInTheDocument();
    expect(screen.getByText('12.')).toBeInTheDocument();
  });

  it('renders 24 words with numbering', () => {
    render(<MnemonicGrid words={TWENTY_FOUR_WORDS} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(24);
    expect(screen.getByText('word24')).toBeInTheDocument();
    expect(screen.getByText('24.')).toBeInTheDocument();
  });

  it('has accessible list semantics with default aria-label', () => {
    render(<MnemonicGrid words={TWELVE_WORDS} />);
    const list = screen.getByRole('list', { name: 'Recovery seed phrase' });
    expect(list).toBeInTheDocument();
  });

  it('accepts a custom aria-label', () => {
    render(<MnemonicGrid words={TWELVE_WORDS} ariaLabel="Custom label" />);
    expect(screen.getByRole('list', { name: 'Custom label' })).toBeInTheDocument();
  });

  it('passes axe accessibility check (AC-27)', async () => {
    const { container } = render(<MnemonicGrid words={TWELVE_WORDS} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
