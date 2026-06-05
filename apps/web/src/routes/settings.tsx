import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { useIsInstanceAdmin } from '../lib/api/auth.ts';
import { AiTab } from '../components/settings/ai-tab.tsx';
import { RolesTab } from '../components/settings/roles-tab.tsx';
import { InvitationsTab } from '../components/settings/invitations-tab.tsx';

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
  component: InstanceSettingsBody,
});

export function SettingsSection({ title, desc, children }: {
  title: string;
  desc: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-8">
      <h2 className="text-sm font-medium">{title}</h2>
      <p className="mb-3 mt-0.5 text-xs text-fg-2">{desc}</p>
      {children}
    </section>
  );
}

// Body of the instance-settings page, sans route shell. The standalone
// `/settings` route renders it bare; the in-workspace `/w/:wslug/instance-settings`
// route renders it INSIDE the workspace Shell+Rail (so it opens with the same
// chrome as workspace settings). Same content either way — instance settings are
// not workspace-scoped; the workspace only provides the rail context.
export function InstanceSettingsBody() {
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

      {isInstanceAdmin ? (
        <>
          <SettingsSection
            title="AI providers"
            desc="Instance-wide AI keys. The runner resolves an agent's key by provider + label."
          >
            <AiTab />
          </SettingsSection>

          <SettingsSection
            title="Roles"
            desc="Each user's instance role. Owner and admin can administer the instance."
          >
            <RolesTab />
          </SettingsSection>

          <SettingsSection
            title="Invitations"
            desc="Grant a user access to a workspace or project, or revoke it."
          >
            <InvitationsTab />
          </SettingsSection>
        </>
      ) : (
        <p className="text-sm text-fg-3">
          You don't have access to any instance-level settings. Workspace settings
          live under each workspace.
        </p>
      )}
    </div>
  );
}
