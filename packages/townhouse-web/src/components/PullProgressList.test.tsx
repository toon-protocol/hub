import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { axe } from '../test-setup';
import { PullProgressList } from './PullProgressList';
import type { WizardProgressMessage } from '@toon-protocol/townhouse';

describe('PullProgressList', () => {
  it('renders empty state when messages are empty', () => {
    render(<PullProgressList messages={[]} />);
    expect(screen.getByText(/Waiting for progress/i)).toBeInTheDocument();
  });

  it('groups and renders pull_progress messages by image', () => {
    const messages: WizardProgressMessage[] = [
      { type: 'pull_progress', image: 'toon:town', status: 'Pulling', progress: '50%', ts: Date.now() },
      { type: 'pull_progress', image: 'toon:connector', status: 'Pulling', ts: Date.now() },
    ];
    render(<PullProgressList messages={messages} />);
    expect(screen.getByText('toon:town')).toBeInTheDocument();
    expect(screen.getByText('toon:connector')).toBeInTheDocument();
  });

  it('shows latest status for each image', () => {
    const messages: WizardProgressMessage[] = [
      { type: 'pull_progress', image: 'toon:town', status: 'Pulling', ts: 1 },
      { type: 'pull_progress', image: 'toon:town', status: 'Pull complete', ts: 2 },
    ];
    render(<PullProgressList messages={messages} />);
    expect(screen.getAllByText('toon:town')).toHaveLength(1);
    expect(screen.getByText('Pull complete')).toBeInTheDocument();
  });

  it('shows container_healthy status', () => {
    const messages: WizardProgressMessage[] = [
      { type: 'container_healthy', name: 'townhouse-town', ts: Date.now() },
    ];
    render(<PullProgressList messages={messages} />);
    expect(screen.getByText('townhouse-town')).toBeInTheDocument();
    expect(screen.getByText('Healthy')).toBeInTheDocument();
  });

  it('passes axe accessibility check', async () => {
    const messages: WizardProgressMessage[] = [
      { type: 'pull_progress', image: 'toon:town', status: 'Pulling', progress: '60%', ts: Date.now() },
    ];
    const { container } = render(<PullProgressList messages={messages} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
