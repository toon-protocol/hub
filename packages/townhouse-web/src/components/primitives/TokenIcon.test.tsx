import { render } from '@testing-library/react';
import { TokenIcon } from './TokenIcon';

describe('TokenIcon', () => {
  it('renders USDC SVG without error', () => {
    const { container } = render(<TokenIcon token="USDC" />);
    expect(container.querySelector('svg')).toBeDefined();
    expect(container.querySelector('text')?.textContent).toBe('U');
  });

  it('renders ETH SVG without error', () => {
    const { container } = render(<TokenIcon token="ETH" />);
    expect(container.querySelector('text')?.textContent).toBe('E');
  });

  it('renders SOL SVG without error', () => {
    const { container } = render(<TokenIcon token="SOL" />);
    expect(container.querySelector('text')?.textContent).toBe('S');
  });

  it('renders MINA SVG without error', () => {
    const { container } = render(<TokenIcon token="MINA" />);
    expect(container.querySelector('text')?.textContent).toBe('M');
  });

  it('is aria-hidden by default', () => {
    const { container } = render(<TokenIcon token="USDC" />);
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('accepts aria-label override', () => {
    const { container } = render(<TokenIcon token="USDC" aria-label="USD Coin" />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('aria-label')).toBe('USD Coin');
    expect(svg.getAttribute('aria-hidden')).toBeNull();
  });
});
