import { useNavigate } from '@tanstack/react-router';
import { AlertTriangle } from 'lucide-react';
import { useProviderHealth, type ProviderHealth } from '../../lib/api/provider-health.ts';
import { Button } from '../ui/button.tsx';

interface Props {
  wslug: string;
}

/**
 * Workspace-level banner that warns when one or more AI providers are degraded
 * (repeated upstream failures). Links to the AI settings tab so the operator can
 * check / rotate the offending key. Renders nothing while healthy.
 */
export function ProviderHealthBanner({ wslug }: Props) {
  const navigate = useNavigate();
  const { data } = useProviderHealth(wslug);
  if (!data) return null;

  const degraded = (Object.entries(data) as [keyof ProviderHealth, ProviderHealth[keyof ProviderHealth]][])
    .filter(([, v]) => v.status === 'degraded')
    .map(([name]) => name);

  if (degraded.length === 0) return null;

  const first = degraded[0] as string;
  const names = degraded.join(', ');

  return (
    <div
      role="alert"
      className="flex items-center gap-2 border-b border-warning/20 bg-bg-warning px-4 py-2 text-xs text-warning"
    >
      <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span className="flex-1">
        AI provider{degraded.length > 1 ? 's' : ''} degraded: <strong>{names}</strong>. Recent
        requests to the provider have been failing.
      </span>
      <Button
        variant="ghost"
        size="sm"
        onClick={() =>
          // AI keys moved to the instance settings page (instance-wide store).
          void navigate({
            to: '/settings',
            search: { tab: 'ai', provider: first },
          })
        }
      >
        Check key →
      </Button>
    </div>
  );
}
