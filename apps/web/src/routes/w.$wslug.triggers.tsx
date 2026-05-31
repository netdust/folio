import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/w/$wslug/triggers')({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: '/w/$wslug/agents',
      params: { wslug: params.wslug },
      search: { tab: 'triggers' },
    });
  },
});
