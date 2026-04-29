'use strict';

/**
 * no-direct-recharts — errors on import ... from 'recharts' outside src/charts/ (AC-9).
 * View stories must import chart components from '@/charts' only.
 */
module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description: "Disallow direct 'recharts' imports outside src/charts/",
    },
    schema: [],
    messages: {
      noDirectRecharts:
        "Direct 'recharts' import is not allowed outside src/charts/. Import from '@/charts' instead.",
    },
  },
  create(context) {
    // Allow imports inside the charts barrel directory only (AC-9).
    const filename = context.getFilename().replace(/\\/g, '/');
    if (filename.includes('/charts/')) return {};

    return {
      ImportDeclaration(node) {
        if (node.source.value === 'recharts') {
          context.report({ node, messageId: 'noDirectRecharts' });
        }
      },
    };
  },
};
