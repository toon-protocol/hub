import './index.css';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';

// AC-8: Fixture-mode guard — the product dev server consumes live Docker data only.
// Storybook bundles run via @storybook/react-vite and set the IS_STORYBOOK build-time flag,
// while Vite dev/build do not. Keying off a build-time flag (set in Storybook's viteFinal)
// is the only reliable way to tell them apart at module init.
if (
  (globalThis as Record<string, unknown>)['__USE_FIXTURES__'] === true &&
  !import.meta.env.STORYBOOK
) {
  throw new Error(
    '[Townhouse] __USE_FIXTURES__ is set outside Storybook context. ' +
    'The product dev server consumes live Docker data only. ' +
    'Remove __USE_FIXTURES__ or use Storybook for isolated primitive preview.'
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('Root element not found');

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
