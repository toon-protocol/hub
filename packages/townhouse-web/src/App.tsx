import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { Home } from './views/Home';
import { TownView } from './views/Town';
import { MillView } from './views/Mill';
import { DvmView } from './views/Dvm';
import { WalletView } from './views/Wallet';
import { WizardView } from './views/Wizard';
import { NotFound } from './views/NotFound';

const router = createBrowserRouter([
  {
    path: '/',
    element: <Home />,
  },
  {
    path: '/wizard',
    element: <WizardView />,
  },
  {
    path: '/town',
    element: <TownView />,
  },
  {
    path: '/mill',
    element: <MillView />,
  },
  {
    path: '/dvm',
    element: <DvmView />,
  },
  {
    path: '/wallet',
    element: <WalletView />,
  },
  {
    path: '*',
    element: <NotFound />,
  },
]);

export function App() {
  return <RouterProvider router={router} />;
}
