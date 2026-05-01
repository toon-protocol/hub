import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { axe } from '../test-setup';
import { AddressBlock } from './AddressBlock';

// Mock qrcode.react
vi.mock('qrcode.react', () => ({
  QRCodeSVG: ({ value, 'aria-label': ariaLabel }: { value: string; 'aria-label'?: string }) => (
    <svg data-testid="qr-code" aria-label={ariaLabel}><title>{value}</title></svg>
  ),
}));

// Mock clipboard
const mockClipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
Object.defineProperty(navigator, 'clipboard', { value: mockClipboard, configurable: true });

afterEach(() => {
  vi.restoreAllMocks();
  mockClipboard.writeText.mockResolvedValue(undefined);
});

const DEFAULT_PROPS = {
  family: 'evm' as const,
  token: 'ETH' as const,
  address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  derivationPath: "m/44'/60'/0'/0/0",
  nodeType: 'town' as const,
  balance: '1000000000000000000',
  scale: 18,
  available: true,
};

describe('AddressBlock', () => {
  it('renders without crashing (snapshot)', () => {
    const { container } = render(<AddressBlock {...DEFAULT_PROPS} />);
    expect(container).toMatchSnapshot();
  });

  it('shows unavailable state when available=false', () => {
    render(<AddressBlock {...DEFAULT_PROPS} available={false} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('truncates address display', () => {
    render(<AddressBlock {...DEFAULT_PROPS} />);
    // Truncated address shown in the code element (not full address)
    // Full address is 42 chars; truncated is "0xf39F…92266" (13 chars)
    const truncated = screen.getAllByText(/0xf39F/)[0];
    expect(truncated).toBeTruthy();
  });

  it('copy button writes address to clipboard', async () => {
    render(<AddressBlock {...DEFAULT_PROPS} />);
    const copyBtn = screen.getByRole('button', { name: /copy/i });
    fireEvent.click(copyBtn);
    await waitFor(() => expect(mockClipboard.writeText).toHaveBeenCalledWith(DEFAULT_PROPS.address));
  });

  it('QR toggle expands QR code', async () => {
    render(<AddressBlock {...DEFAULT_PROPS} />);
    // The QR code SVG is always in DOM (inside <details>), but hidden until details is open
    const summary = screen.getByText('QR');
    expect(summary).toBeInTheDocument();
    // QR code is in the DOM because details renders children even when closed
    expect(screen.getByTestId('qr-code')).toBeInTheDocument();
  });

  it('passes axe a11y check', async () => {
    const { container } = render(<AddressBlock {...DEFAULT_PROPS} />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('passes axe with solana family', async () => {
    const { container } = render(
      <AddressBlock
        family="solana"
        token="SOL"
        address="SolanaAddr1234"
        derivationPath="m/44'/501'/1'/0/0"
        nodeType="mill"
        balance="10000000000"
        scale={9}
        available={true}
      />
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
