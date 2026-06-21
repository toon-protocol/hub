import { render, screen } from '@testing-library/react';
import { StatusDot } from './StatusDot';

describe('StatusDot', () => {
  it('has aria-label for each state', () => {
    const states = ['ok', 'degraded', 'down', 'unknown'] as const;
    for (const state of states) {
      const { unmount } = render(<StatusDot state={state} />);
      const el = screen.getByRole('img');
      expect(el).toHaveAttribute('aria-label');
      expect(el.getAttribute('aria-label')).toContain(state === 'ok' ? 'Online' : '');
      unmount();
    }
  });

  it('accepts custom aria-label', () => {
    render(<StatusDot state="ok" aria-label="Node is running" />);
    expect(screen.getByRole('img', { name: 'Node is running' })).toBeDefined();
  });

  it('defaults to unknown state', () => {
    render(<StatusDot />);
    expect(screen.getByRole('img')).toHaveAttribute('aria-label', 'Status: Unknown');
  });
});
