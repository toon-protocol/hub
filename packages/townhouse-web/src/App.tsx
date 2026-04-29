import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { Home } from './pages/Home';

const router = createBrowserRouter([
  {
    path: '/',
    element: <Home />,
  },
]);

export function App() {
  return <RouterProvider router={router} />;
}
