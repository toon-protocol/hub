'use strict';

/**
 * no-positive-letter-spacing-geist — errors on tracking/letter-spacing > 0
 * applied to a font-geist-sans element (AC-9).
 * Geist uses aggressive negative tracking; positive spacing is a design violation.
 *
 * Coverage: scans every string Literal and TemplateLiteral quasi in the file
 * so the rule fires on className strings whether they live in a JSXAttribute
 * or are passed through cn()/cva()/clsx() helpers.
 */
module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow positive letter-spacing on font-geist-sans elements',
    },
    schema: [],
    messages: {
      noPositiveTracking:
        "Positive letter-spacing/tracking '{{value}}' must not be used on Geist Sans elements. Use negative (tight-*) values only.",
    },
  },
  create(context) {
    // Match any tracking-* class that isn't the project's negative tight-* family
    // and isn't tracking-normal. Catches Tailwind's tracking-wide / -wider / -widest
    // and any custom positive tokens.
    const POSITIVE_TRACKING_RE = /\btracking-(?!tight\b|tight-|normal\b)[\w-]+/;

    function checkClassString(node, classStr) {
      const classes = classStr.split(/\s+/);
      const hasGeistSans = classes.some((c) => c === 'font-geist-sans');
      if (!hasGeistSans) return;

      for (const cls of classes) {
        if (POSITIVE_TRACKING_RE.test(cls)) {
          context.report({
            node,
            messageId: 'noPositiveTracking',
            data: { value: cls },
          });
        }
      }
    }

    return {
      Literal(node) {
        if (typeof node.value !== 'string') return;
        if (!/font-geist-sans/.test(node.value)) return;
        checkClassString(node, node.value);
      },
      TemplateElement(node) {
        const raw = node.value.cooked ?? node.value.raw ?? '';
        if (!/font-geist-sans/.test(raw)) return;
        checkClassString(node, raw);
      },
    };
  },
};
