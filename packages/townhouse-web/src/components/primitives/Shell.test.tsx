import { render, screen } from '@testing-library/react';
import { Shell } from './Shell';

describe('Shell', () => {
  it('renders children inside main', () => {
    render(<Shell>Hello</Shell>);
    expect(screen.getByRole('main')).toHaveTextContent('Hello');
  });

  it('renders header when provided', () => {
    render(<Shell header={<span>Header</span>}>Content</Shell>);
    expect(screen.getByRole('banner')).toHaveTextContent('Header');
  });

  it('renders footer when provided', () => {
    render(<Shell footer={<span>Footer</span>}>Content</Shell>);
    expect(screen.getByRole('contentinfo')).toHaveTextContent('Footer');
  });

  it('omits header/footer when not provided', () => {
    render(<Shell>Content</Shell>);
    expect(screen.queryByRole('banner')).toBeNull();
    expect(screen.queryByRole('contentinfo')).toBeNull();
  });
});
