import { createFileRoute, Link } from '@tanstack/react-router';
import { z } from 'zod';
import { SYSTEM_WORKSPACE_SLUG } from '../lib/api/workspaces.ts';
import { useIsInstanceAdmin, useIsSystemMember } from '../lib/api/auth.ts';
import { AiTab } from '../components/settings/ai-tab.tsx';

const settingsSearchSchema = z.object({
  // Deep-link target. The provider-health banner's "Check key →" lands here.
  tab: z.enum(['ai']).optional(),
  // Carried for a future per-provider preselect (AiTab owns its provider state).
  provider: z.string().optional(),
});

// Instance-level settings — surfaces that are NOT workspace-scoped: the shared
// AI provider keys (one store for the whole instance) and the System Library.
// Workspace-scoped settings (API tokens) stay at /w/:wslug/settings.
export const Route = createFileRoute('/settings')({
  validateSearch: settingsSearchSchema,
  component: InstanceSettingsPage,
});

function InstanceSettingsPage() {
  const isSystemMember = useIsSystemMember();
  const isInstanceAdmin = useIsInstanceAdmin();

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <header className="mb-6">
        <div className="text-[10px] uppercase tracking-wide text-fg-3">Instance</div>
        <h1 className="text-lg font-medium tracking-tight">Instance settings</h1>
        <p className="mt-1 text-xs text-fg-2">
          Settings that apply across the whole instance, not a single workspace.
        </p>
      </header>

      {/* AI provider keys — instance-wide, instance-admin only. */}
      {isInstanceAdmin ? (
        <section className="mb-8">
          <AiTab />
        </section>
      ) : null}

      {/* System Library — any __system member. */}
      {isSystemMember ? (
        <section className="rounded-md border border-border-light bg-shell p-4">
          <h2 className="text-sm font-medium">System Library</h2>
          <p className="mt-0.5 text-xs text-fg-2">
            Curate the shared library agents and triggers that any workspace can
            run. Opens the System Library's automation page.
          </p>
          <Link
            to="/w/$wslug/agents"
            params={{ wslug: SYSTEM_WORKSPACE_SLUG }}
            className="mt-3 inline-block text-sm text-fg-2 hover:text-fg"
          >
            Open System Library →
          </Link>
        </section>
      ) : null}

      {/* Neither an instance admin nor a __system member — nothing to manage. */}
      {!isInstanceAdmin && !isSystemMember ? (
        <p className="text-sm text-fg-3">
          You don't have access to any instance-level settings. Workspace settings
          live under each workspace.
        </p>
      ) : null}
    </div>
  );
}
