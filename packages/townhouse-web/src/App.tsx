import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { Home } from './views/Home';
import { TownView } from './views/Town';
import { MillView } from './views/Mill';
import { NotFound } from './views/NotFound';

const router = createBrowserRouter([
  {
    path: '/',
    element: <Home />,
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
    path: '*',
    element: <NotFound />,
  },
]);

export function App() {
  return <RouterProvider router={router} />;
}
