import { render } from '@testing-library/react';
import { ChainIcon } from './ChainIcon';

describe('ChainIcon', () => {
  it('renders evm SVG without error', () => {
    const { container } = render(<ChainIcon chain="evm" />);
    expect(container.querySelector('svg')).toBeDefined();
  });

  it('renders solana SVG without error', () => {
    const { container } = render(<ChainIcon chain="solana" />);
    expect(container.querySelector('svg')).toBeDefined();
  });

  it('renders mina SVG without error', () => {
    const { container } = render(<ChainIcon chain="mina" />);
    expect(container.querySelector('svg')).toBeDefined();
  });

  it('is aria-hidden by default', () => {
    const { container } = render(<ChainIcon chain="evm" />);
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('accepts aria-label override', () => {
    const { container } = render(<ChainIcon chain="evm" aria-label="Ethereum" />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('aria-label')).toBe('Ethereum');
    expect(svg.getAttribute('aria-hidden')).toBeNull();
  });

  it('respects custom size', () => {
    const { container } = render(<ChainIcon chain="evm" size={24} />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('width')).toBe('24');
    expect(svg.getAttribute('height')).toBe('24');
  });
});
