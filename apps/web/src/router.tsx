import { createRouter } from '@tanstack/react-router';
import { queryClient } from './lib/query';
import { routeTree } from './routeTree.gen';

export const router = createRouter({
  routeTree,
  context: { queryClient },
  defaultPreload: 'intent',
  defaultPreloadStaleTime: 0,
  defaultPendingMs: 150,
  defaultPendingMinMs: 300,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
