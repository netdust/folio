import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/w/$wslug/p/$pslug/')({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: '/w/$wslug/p/$pslug/work-items',
      params: { wslug: params.wslug, pslug: params.pslug },
      replace: true,
    });
  },
});
