import { render, screen } from '@testing-library/react';
import { StateShell } from './StateShell';

describe('StateShell', () => {
  it('renders children in ready state', () => {
    render(<StateShell state="ready">Ready content</StateShell>);
    expect(screen.getByText('Ready content')).toBeDefined();
  });

  it('renders loading indicator in loading state', () => {
    render(<StateShell state="loading" />);
    expect(screen.getByRole('status', { name: 'Loading' })).toBeDefined();
  });

  it('renders empty message in empty state', () => {
    render(<StateShell state="empty" />);
    expect(screen.getByRole('status')).toHaveTextContent('Nothing here yet');
  });

  it('renders error message in error state', () => {
    render(<StateShell state="error" />);
    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong');
  });

  it('renders custom loading slot', () => {
    render(<StateShell state="loading" loadingSlot={<div>Custom loading...</div>} />);
    expect(screen.getByText('Custom loading...')).toBeDefined();
  });

  it('renders custom error slot', () => {
    render(<StateShell state="error" errorSlot={<div role="alert">Custom error</div>} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Custom error');
  });
});
