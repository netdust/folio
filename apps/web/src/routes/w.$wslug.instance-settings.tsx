import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { InstanceSettingsBody } from './settings.tsx';

// Instance settings rendered INSIDE the workspace Shell+Rail (child of
// /w/$wslug, exactly like /w/$wslug/settings) so it opens with the same chrome
// as workspace settings — the rail stays visible. The content is identical to
// the standalone /settings route: instance settings are NOT workspace-scoped;
// the workspace only supplies the rail context. The "Settings" entry in the
// user menu points here.
export const Route = createFileRoute('/w/$wslug/instance-settings')({
  validateSearch: z.object({
    tab: z.enum(['ai']).optional(),
    provider: z.string().optional(),
  }),
  component: InstanceSettingsBody,
});
