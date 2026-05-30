import { AlertTriangle } from 'lucide-react';
import { useReactorHealth } from '../../lib/api/provider-health.ts';

interface Props {
  wslug: string;
}

/**
 * Workspace-level banner that warns when the reaction plane has halted (the
 * runner dispatcher tripped its circuit breaker). System-level notice — no
 * action link. Shows the error CLASS only, never the message or any tenant data
 * (threat-model mitigation 53). Renders nothing while running normally.
 */
export function ReactorHaltBanner({ wslug }: Props) {
  const { halted, errorClass } = useReactorHealth(wslug);
  if (!halted) return null;

  return (
    <div
      role="alert"
      className="flex items-center gap-2 border-b border-danger/20 bg-bg-danger px-4 py-2 text-xs text-danger"
    >
      <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span className="flex-1">
        <strong>Automation paused.</strong> The reaction plane halted after a fault
        {errorClass ? (
          <>
            {' '}(<code className="font-mono">{errorClass}</code>)
          </>
        ) : null}
        . Agent triggers are not running until it recovers.
      </span>
    </div>
  );
}
