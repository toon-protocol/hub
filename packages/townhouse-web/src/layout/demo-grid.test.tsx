import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DemoGrid } from './demo-grid';

describe('DemoGrid', () => {
  it('renders both left and right slots', () => {
    render(
      <DemoGrid
        left={<div data-testid="left-slot">LEFT</div>}
        right={<div data-testid="right-slot">RIGHT</div>}
      />
    );
    expect(screen.getByTestId('left-slot')).toHaveTextContent('LEFT');
    expect(screen.getByTestId('right-slot')).toHaveTextContent('RIGHT');
  });

  it('uses a 50/50 grid layout at lg+ breakpoint', () => {
    render(
      <DemoGrid
        left={<span data-testid="left" />}
        right={<span data-testid="right" />}
      />
    );
    const grid = screen.getByTestId('demo-grid');
    // Locked in by AC-D9-2: 50/50 at lg, single column below.
    expect(grid.className).toMatch(/grid-cols-1/);
    expect(grid.className).toMatch(/lg:grid-cols-2/);
    // Children must be ordered left-then-right so the demo composition is
    // stable.
    const sections = grid.querySelectorAll('section');
    expect(sections.length).toBe(2);
    expect(sections[0]).toContainElement(screen.getByTestId('left'));
    expect(sections[1]).toContainElement(screen.getByTestId('right'));
  });

  it('exposes accessible region labels for left and right halves', () => {
    render(
      <DemoGrid
        left={<span>L</span>}
        right={<span>R</span>}
      />
    );
    expect(screen.getByRole('region', { name: /ditto client/i })).toBeInTheDocument();
    expect(
      screen.getByRole('region', { name: /operator ops panels/i })
    ).toBeInTheDocument();
  });
});
