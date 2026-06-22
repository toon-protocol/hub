'use strict';

module.exports = {
  rules: {
    'no-inline-hex': require('./rules/no-inline-hex.cjs'),
    'no-positive-letter-spacing-geist': require('./rules/no-positive-letter-spacing-geist.cjs'),
    'no-raw-border': require('./rules/no-raw-border.cjs'),
    'no-direct-recharts': require('./rules/no-direct-recharts.cjs'),
  },
};
