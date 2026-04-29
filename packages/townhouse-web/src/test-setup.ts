import '@testing-library/jest-dom';
import { configureAxe, toHaveNoViolations } from 'jest-axe';
import { expect } from 'vitest';

expect.extend(toHaveNoViolations);

export const axe = configureAxe({
  rules: {
    // Require WCAG 2.1 AA
    'color-contrast': { enabled: true },
  },
});
