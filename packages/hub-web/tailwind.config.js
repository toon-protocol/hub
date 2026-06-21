/** @type {import('tailwindcss').Config} */

// Tokens are emitted from src/theme/tokens.ts → src/theme/tokens.json by
// scripts/build-tokens.mjs (run as prebuild/predev). Single source of truth.
const tokens = require('./src/theme/tokens.json');

const animationsToTailwind = Object.fromEntries(
  Object.entries(tokens.animations).map(([name, def]) => [
    name,
    `${name} ${def.duration} ${def.easing}${name === 'pulse-soft' || name === 'rebal-pulse' ? ' infinite' : ''}`,
  ]),
);

const keyframesToTailwind = Object.fromEntries(
  Object.entries(tokens.animations).map(([name, def]) => [name, def.keyframes]),
);

const letterSpacing = Object.fromEntries(
  Object.entries(tokens.typescale)
    .filter(([, def]) => def.tracking !== '0rem')
    .map(([key, def]) => [`tight-${key}`, def.tracking]),
);

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        canvas: tokens.colors.canvas,
        ink: tokens.colors.ink,
        'type-town': tokens.colors.type.town,
        'type-mill': tokens.colors.type.mill,
        'type-dvm': tokens.colors.type.dvm,
      },
      fontFamily: {
        'geist-sans': ['Geist', 'system-ui', 'sans-serif'],
        'geist-mono': ['"Geist Mono"', 'ui-monospace', 'monospace'],
      },
      fontWeight: tokens.fontWeights,
      letterSpacing,
      keyframes: keyframesToTailwind,
      animation: animationsToTailwind,
      spacing: tokens.spacing,
      screens: tokens.breakpoints,
    },
  },
  plugins: [
    require('@tailwindcss/typography'),
    require('tailwindcss-animate'),
    // shadow-border utility: replaces CSS border declarations (D21-008 rule)
    function ({ addUtilities }) {
      addUtilities({
        '.shadow-border': {
          'box-shadow': tokens.shadowBorder,
        },
      });
    },
  ],
};
