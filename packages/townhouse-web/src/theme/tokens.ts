/**
 * Design tokens — single source of truth for all visual values (D21-008).
 * All other code imports from here. Never inline hex values or raw size literals.
 */

// ── Colors ─────────────────────────────────────────────────────────────────

export const colors = {
  canvas: '#ffffff',
  ink: '#171717',
  shadow: 'rgba(0,0,0,0.08)',
  // Node-type workflow accents (D21-008 exact hex values)
  type: {
    town: '#0a72ef',  // Vercel Develop Blue
    mill: '#de1d8d',  // Vercel Preview Pink
    dvm: '#ff5b4f',   // Vercel Ship Red
  },
} as const;

// ── Typography ─────────────────────────────────────────────────────────────

/** [fontSize, letterSpacing] pairs — letter-spacing in px, negative = tighter */
export const typescale = {
  '48': { size: '3rem',   tracking: '-0.15rem'  },  // -2.4 / 16 = -0.15rem
  '32': { size: '2rem',   tracking: '-0.1rem'   },  // -1.6 / 16
  '24': { size: '1.5rem', tracking: '-0.0625rem'},  // -1.0 / 16
  '16': { size: '1rem',   tracking: '-0.025rem' },  // -0.4 / 16
  '14': { size: '0.875rem', tracking: '-0.0125rem'},// -0.2 / 16
  '12': { size: '0.75rem',  tracking: '0rem'    },  // 0
} as const;

export const fontWeights = {
  normal: '400',
  medium: '500',
  semibold: '600',
} as const;

export const fontFamilies = {
  sans: 'Geist, system-ui, sans-serif',
  mono: '"Geist Mono", ui-monospace, monospace',
} as const;

// ── Animations ─────────────────────────────────────────────────────────────

export const animations = {
  'fade-in': {
    keyframes: { from: { opacity: '0' }, to: { opacity: '1' } },
    duration: '200ms',
    easing: 'ease-out',
  },
  'pulse-soft': {
    keyframes: {
      '0%, 100%': { opacity: '1' },
      '50%': { opacity: '0.5' },
    },
    duration: '2000ms',
    easing: 'ease-in-out',
  },
  'rebal-pulse': {
    keyframes: {
      '0%, 100%': { transform: 'scale(1)' },
      '50%': { transform: 'scale(1.05)' },
    },
    duration: '1500ms',
    easing: 'ease-in-out',
  },
} as const;

// ── Spacing ─────────────────────────────────────────────────────────────────

export const spacing = {
  1: '0.25rem',  // 4px
  2: '0.5rem',   // 8px
  3: '0.75rem',  // 12px
  4: '1rem',     // 16px
  6: '1.5rem',   // 24px
  8: '2rem',     // 32px
  12: '3rem',    // 48px
  16: '4rem',    // 64px
} as const;

// ── Breakpoints ─────────────────────────────────────────────────────────────

export const breakpoints = {
  xs: '400px',
  sm: '600px',
  md: '768px',
  lg: '1024px',
  xl: '1200px',
  '2xl': '1400px',
} as const;

// ── Shadow ───────────────────────────────────────────────────────────────────

/** shadow-border utility: replaces CSS border declarations (D21-008 rule) */
export const shadowBorder = `0 0 0 1px ${colors.shadow}`;
