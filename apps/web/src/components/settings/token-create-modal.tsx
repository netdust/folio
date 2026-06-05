import { useCreateToken } from '../../lib/api/tokens.ts';
import { TokenCreateDialog, type ScopePreset } from './token-create-dialog.tsx';

const ALL_SCOPES = [
  'documents:read',
  'documents:write',
  'documents:delete',
  // Phase 2 consolidated the four granular config scopes
  // (fields/views/tables/statuses:write) into one canonical config:write.
  'config:write',
  // Phase 2.6 sub-phase D — required for MCP agent-lifecycle tools.
  'agents:write',
  // Agent-authority phase A5 — instance/admin scopes. NEVER bundled into a
  // preset (BUG-007); users tick them explicitly.
  'settings:write',
  'members:write',
  'workspace:admin',
] as const;

// BUG-007: agents:write + admin scopes are deliberately NOT in any preset —
// bundling them would silently grant agent-management / instance authority.
const PRESETS: ScopePreset[] = [
  { label: 'Read-only', scopes: ['documents:read'] },
  { label: 'Read + write', scopes: ['documents:read', 'documents:write', 'config:write'] },
  {
    label: 'Full access',
    tone: 'danger',
    scopes: ['documents:read', 'documents:write', 'documents:delete', 'config:write'],
  },
];

interface Props {
  wslug: string;
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// Per-workspace token creation. Instance-wide (reach=null) tokens are minted on
// the instance Settings page (InstanceTokensTab), NOT here — this modal always
// pins to the current workspace. Thin wrapper over the shared TokenCreateDialog.
export function TokenCreateModal({ wslug, workspaceId, open, onOpenChange }: Props) {
  const create = useCreateToken(wslug, workspaceId);
  return (
    <TokenCreateDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Create API token"
      description="Tokens authenticate agents and external integrations. Scopes are enforced on every write."
      allScopes={ALL_SCOPES}
      presets={PRESETS}
      allScopesWarning="This token will have every scope on this workspace — root-level access including destructive operations. Use for trusted agents only."
      mutate={(vars) => create.mutateAsync(vars)}
      isPending={create.isPending}
    />
  );
}
