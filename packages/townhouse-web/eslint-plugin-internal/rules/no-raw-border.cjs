'use strict';

/**
 * no-raw-border — errors on CSS border declarations and Tailwind border utilities
 * that produce border: 1px solid (AC-9). Use shadow-border instead.
 *
 * Coverage: scans every string Literal and TemplateLiteral quasi in the file
 * (className attributes, cn()/cva()/clsx() arguments, cva variant strings, etc.)
 * plus CSS-in-JS object property keys.
 */
module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow raw CSS border declarations. Use shadow-border (box-shadow) instead.',
    },
    schema: [],
    messages: {
      noRawBorder:
        "Raw border '{{value}}' is not allowed. Use 'shadow-border' (box-shadow: 0 0 0 1px rgba(0,0,0,0.08)) instead.",
    },
  },
  create(context) {
    // Tokens that START with 'border' and are explicit safe exceptions.
    const SAFE_BORDER_PREFIXES = [
      'border-0', 'border-none', 'border-transparent', 'border-collapse',
      'border-separate', 'border-spacing', 'border-x-0', 'border-y-0',
      'border-t-0', 'border-r-0', 'border-b-0', 'border-l-0',
    ];

    function isBorderViolation(cls) {
      if (!cls.startsWith('border')) return false;
      if (SAFE_BORDER_PREFIXES.some((safe) => cls === safe || cls.startsWith(safe))) return false;
      return true;
    }

    function checkClassString(node, classStr) {
      const classes = classStr.split(/\s+/);
      for (const cls of classes) {
        if (isBorderViolation(cls)) {
          context.report({
            node,
            messageId: 'noRawBorder',
            data: { value: cls },
          });
        }
      }
    }

    return {
      // Catch every string literal that LOOKS like a className token list.
      // We scan all string Literals and TemplateLiteral quasis — keeps the rule
      // independent of whether the string lives in a JSXAttribute or a CallExpression.
      Literal(node) {
        if (typeof node.value !== 'string') return;
        // Heuristic: only inspect strings that contain whitespace-separated tokens
        // OR begin with `border` themselves. Skip pure non-className strings.
        if (!/^border|\sborder/.test(node.value) && !/^border/.test(node.value)) return;
        checkClassString(node, node.value);
      },
      TemplateElement(node) {
        const raw = node.value.cooked ?? node.value.raw ?? '';
        if (!/^border|\sborder/.test(raw) && !/^border/.test(raw)) return;
        checkClassString(node, raw);
      },
      Property(node) {
        // Catch CSS-in-JS: { border: '...' } / { borderWidth: '...' } / etc.
        if (node.computed) return;
        const keyName =
          node.key.type === 'Identifier'
            ? node.key.name
            : node.key.type === 'Literal'
            ? String(node.key.value)
            : null;
        if (keyName && /^border(Width|Top|Bottom|Left|Right|Style)?$/.test(keyName)) {
          context.report({
            node,
            messageId: 'noRawBorder',
            data: { value: keyName },
          });
        }
      },
    };
  },
};
