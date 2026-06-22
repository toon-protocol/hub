'use strict';

/**
 * no-inline-hex — errors on any #[0-9a-fA-F]{3,8} literal outside theme/tokens.ts.
 * Enforces: all hex colours must come from @/theme/tokens (AC-9).
 */
module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow inline hex colour literals outside theme/tokens.ts',
    },
    schema: [],
    messages: {
      noInlineHex:
        "Inline hex '{{value}}' is not allowed. Import colour values from '@/theme/tokens'.",
    },
  },
  create(context) {
    // Allow the file that owns the tokens
    if (context.getFilename().includes('theme/tokens')) return {};

    return {
      Literal(node) {
        if (
          typeof node.value === 'string' &&
          /^#[0-9a-fA-F]{3,8}$/.test(node.value)
        ) {
          context.report({
            node,
            messageId: 'noInlineHex',
            data: { value: node.value },
          });
        }
      },
      TemplateLiteral(node) {
        const raw = node.quasis.map((q) => q.value.raw).join('');
        const hexRe = /#[0-9a-fA-F]{3,8}/g;
        let match;
        while ((match = hexRe.exec(raw)) !== null) {
          context.report({
            node,
            messageId: 'noInlineHex',
            data: { value: match[0] },
          });
        }
      },
    };
  },
};
