import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { TokenCreateModal } from './token-create-modal.tsx';

afterEach(() => {
  vi.unstubAllGlobals();
});

function wrap(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

const SCOPES = [
  'documents:read',
  'documents:write',
  'documents:delete',
  // Phase 2 consolidated fields/views/tables/statuses:write into one canonical
  // config:write. The four granular scopes can no longer be minted, so the
  // modal must not offer them.
  'config:write',
  // Phase 2.6 sub-phase D — agents:write scope for MCP agent-lifecycle tools.
  'agents:write',
] as const;

const DEAD_GRANULAR_SCOPES = ['fields:write', 'views:write', 'tables:write', 'statuses:write'];

describe('TokenCreateModal', () => {
  it('renders a checkbox for every v1 scope', () => {
    const qc = new QueryClient();
    render(
      <TokenCreateModal wslug="acme" workspaceId="ws-1" open onOpenChange={() => {}} />,
      { wrapper: wrap(qc) },
    );
    for (const scope of SCOPES) {
      expect(screen.getByLabelText(scope)).toBeInTheDocument();
    }
  });

  it('does NOT offer the dead granular config scopes', () => {
    const qc = new QueryClient();
    render(
      <TokenCreateModal wslug="acme" workspaceId="ws-1" open onOpenChange={() => {}} />,
      { wrapper: wrap(qc) },
    );
    for (const scope of DEAD_GRANULAR_SCOPES) {
      expect(screen.queryByLabelText(scope)).toBeNull();
    }
  });

  it('disables Create until name is non-empty AND at least one scope is checked', async () => {
    const qc = new QueryClient();
    const user = userEvent.setup();
    render(
      <TokenCreateModal wslug="acme" workspaceId="ws-1" open onOpenChange={() => {}} />,
      { wrapper: wrap(qc) },
    );
    const button = screen.getByRole('button', { name: /create/i });
    expect(button).toBeDisabled();
    await user.type(screen.getByLabelText(/^name$/i), 'CI');
    expect(button).toBeDisabled(); // no scope yet
    await user.click(screen.getByLabelText('documents:read'));
    expect(button).not.toBeDisabled();
  });

  it('exposes Read-only / Read + write / Full access preset buttons', () => {
    const qc = new QueryClient();
    render(
      <TokenCreateModal wslug="acme" workspaceId="ws-1" open onOpenChange={() => {}} />,
      { wrapper: wrap(qc) },
    );
    expect(screen.getByRole('button', { name: /read-only/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /read \+ write/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /full access/i })).toBeInTheDocument();
  });

  it('clicking "Read + write" checks documents:read/write + config:write (no delete, no agents:write)', async () => {
    const qc = new QueryClient();
    const user = userEvent.setup();
    render(
      <TokenCreateModal wslug="acme" workspaceId="ws-1" open onOpenChange={() => {}} />,
      { wrapper: wrap(qc) },
    );
    await user.click(screen.getByRole('button', { name: /read \+ write/i }));
    expect((screen.getByLabelText('documents:read') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('documents:write') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('config:write') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('documents:delete') as HTMLInputElement).checked).toBe(false);
    // BUG-007 — agents:write is too privileged to bundle in a "Read + write"
    // preset; human PATs bypass the widening guards so the preset would
    // silently grant whole-instance agent-management capability.
    expect((screen.getByLabelText('agents:write') as HTMLInputElement).checked).toBe(false);
  });

  // BUG-007 — neither preset bundles agents:write. Users who genuinely need
  // it tick the box manually (and see the warning that agents:write paired
  // with documents:* is workspace-admin capability).
  it('"Read-only" preset does NOT include agents:write', async () => {
    const qc = new QueryClient();
    const user = userEvent.setup();
    render(
      <TokenCreateModal wslug="acme" workspaceId="ws-1" open onOpenChange={() => {}} />,
      { wrapper: wrap(qc) },
    );
    await user.click(screen.getByRole('button', { name: /^read-only$/i }));
    expect((screen.getByLabelText('agents:write') as HTMLInputElement).checked).toBe(false);
  });

  it('"Full access" preset does NOT include agents:write (BUG-007)', async () => {
    const qc = new QueryClient();
    const user = userEvent.setup();
    render(
      <TokenCreateModal wslug="acme" workspaceId="ws-1" open onOpenChange={() => {}} />,
      { wrapper: wrap(qc) },
    );
    await user.click(screen.getByRole('button', { name: /full access/i }));
    expect((screen.getByLabelText('agents:write') as HTMLInputElement).checked).toBe(false);
  });

  it('clicking "Full access" checks every scope except agents:write', async () => {
    const qc = new QueryClient();
    const user = userEvent.setup();
    render(
      <TokenCreateModal wslug="acme" workspaceId="ws-1" open onOpenChange={() => {}} />,
      { wrapper: wrap(qc) },
    );
    await user.click(screen.getByRole('button', { name: /full access/i }));
    for (const scope of SCOPES) {
      const expected = scope !== 'agents:write';
      expect((screen.getByLabelText(scope) as HTMLInputElement).checked).toBe(expected);
    }
  });

  it('on submit, calls POST and reveals the plaintext token with a copy button', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: {
                id: 'tok_1',
                name: 'CI',
                token: 'folio_pat_secret_xyz',
                scopes: ['documents:read'],
              },
            }),
            { status: 201, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );
    const user = userEvent.setup();
    render(
      <TokenCreateModal wslug="acme" workspaceId="ws-1" open onOpenChange={() => {}} />,
      { wrapper: wrap(qc) },
    );
    await user.type(screen.getByLabelText(/^name$/i), 'CI');
    await user.click(screen.getByLabelText('documents:read'));
    await user.click(screen.getByRole('button', { name: /create/i }));

    await waitFor(() => {
      expect(screen.getByText(/folio_pat_secret_xyz/)).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /copy/i })).toBeInTheDocument();
    // Warning that this is the only time
    expect(screen.getByText(/only time|won't be shown again|copy it now/i)).toBeInTheDocument();
  });

  // Bug H (2026-05-26): "Full access" looked like just another grey preset.
  // It now reads as the dangerous option — distinct styling + a warning line
  // when every scope is selected.
  it('renders "Full access" preset with a destructive accent (data-tone="danger")', () => {
    const qc = new QueryClient();
    render(
      <TokenCreateModal wslug="acme" workspaceId="ws-1" open onOpenChange={() => {}} />,
      { wrapper: wrap(qc) },
    );
    const fullAccess = screen.getByRole('button', { name: /full access/i });
    expect(fullAccess.getAttribute('data-tone')).toBe('danger');
    // Other presets are not danger-toned.
    expect(screen.getByRole('button', { name: /^read-only$/i }).getAttribute('data-tone')).not.toBe('danger');
    expect(screen.getByRole('button', { name: /read \+ write/i }).getAttribute('data-tone')).not.toBe('danger');
  });

  it('shows a warning alert only when EVERY scope (including manually-ticked agents:write) is selected', async () => {
    const qc = new QueryClient();
    const user = userEvent.setup();
    render(
      <TokenCreateModal wslug="acme" workspaceId="ws-1" open onOpenChange={() => {}} />,
      { wrapper: wrap(qc) },
    );
    // No warning before any preset is clicked.
    expect(screen.queryByRole('alert')).toBeNull();
    // Full access alone is not enough — BUG-007 drops agents:write from
    // the preset, and A11 adds three admin scopes that no preset bundles, so
    // the user-visible state is "every scope except agents:write + admin".
    await user.click(screen.getByRole('button', { name: /full access/i }));
    expect(screen.queryByRole('alert')).toBeNull();
    // Manually ticking the remaining non-preset scopes tips it into "every
    // scope" → warning.
    await user.click(screen.getByLabelText('agents:write'));
    await user.click(screen.getByLabelText('settings:write'));
    await user.click(screen.getByLabelText('members:write'));
    await user.click(screen.getByLabelText('workspace:admin'));
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toMatch(/every scope|root-level|trusted/i);
  });

  it('hides the warning when any scope is unchecked from the full set', async () => {
    const qc = new QueryClient();
    const user = userEvent.setup();
    render(
      <TokenCreateModal wslug="acme" workspaceId="ws-1" open onOpenChange={() => {}} />,
      { wrapper: wrap(qc) },
    );
    await user.click(screen.getByRole('button', { name: /full access/i }));
    await user.click(screen.getByLabelText('agents:write'));
    await user.click(screen.getByLabelText('settings:write'));
    await user.click(screen.getByLabelText('members:write'));
    await user.click(screen.getByLabelText('workspace:admin'));
    expect(screen.getByRole('alert')).toBeInTheDocument();
    // Uncheck one scope — warning should disappear because it's no longer "every scope".
    await user.click(screen.getByLabelText('config:write'));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('per-workspace reach + admin scopes', () => {
  const ADMIN_SCOPES = ['settings:write', 'members:write', 'workspace:admin'] as const;

  function stubCreateFetch() {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: {
              id: 'tok_1',
              name: 'CI',
              token: 'folio_pat_x',
              scopes: ['documents:read'],
            },
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('ALWAYS pins to the URL workspace — no workspaceId in the body, no reach option', async () => {
    // Instance (reach=null) tokens moved to the Settings page; this modal can no
    // longer mint one. There is no reach toggle, and the create body never carries
    // workspaceId (the server pins to the URL workspace).
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const fetchMock = stubCreateFetch();
    const user = userEvent.setup();
    render(
      <TokenCreateModal wslug="acme" workspaceId="ws-1" open onOpenChange={() => {}} />,
      { wrapper: wrap(qc) },
    );
    // No reach UI at all.
    expect(screen.queryByText(/whole instance/i)).toBeNull();
    expect(screen.queryByLabelText(/whole instance/i)).toBeNull();
    expect(screen.queryByText(/^reach$/i)).toBeNull();

    await user.type(screen.getByLabelText(/^name$/i), 'CI');
    await user.click(screen.getByLabelText('documents:read'));
    await user.click(screen.getByRole('button', { name: /create/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).not.toHaveProperty('workspaceId');
  });

  it('includes expires_in_days in the POST body when the expiry field is filled', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const fetchMock = stubCreateFetch();
    const user = userEvent.setup();
    render(
      <TokenCreateModal wslug="acme" workspaceId="ws-1" open onOpenChange={() => {}} />,
      { wrapper: wrap(qc) },
    );
    await user.type(screen.getByLabelText(/^name$/i), 'CI');
    await user.click(screen.getByLabelText('documents:read'));
    await user.type(screen.getByLabelText(/expires in/i), '30');
    await user.click(screen.getByRole('button', { name: /^create$/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.expires_in_days).toBe(30);
  });

  it('blocks a decimal expiry (3.5) — Create disabled + inline hint, no POST', async () => {
    // Finding 3: the server validates with z.number().int(); a decimal passed a
    // naive client check and came back as an opaque 400. The dialog must reject
    // it client-side instead.
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const fetchMock = stubCreateFetch();
    const user = userEvent.setup();
    render(
      <TokenCreateModal wslug="acme" workspaceId="ws-1" open onOpenChange={() => {}} />,
      { wrapper: wrap(qc) },
    );
    await user.type(screen.getByLabelText(/^name$/i), 'CI');
    await user.click(screen.getByLabelText('documents:read'));
    await user.type(screen.getByLabelText(/expires in/i), '3.5');

    // Inline hint appears and Create is blocked.
    expect(screen.getByRole('alert').textContent).toMatch(/whole number/i);
    expect(screen.getByRole('button', { name: /^create$/i })).toBeDisabled();

    // Even if the disabled button is force-clicked, no POST fires.
    await user.click(screen.getByRole('button', { name: /^create$/i }));
    expect(
      fetchMock.mock.calls.find((c) => (c[1] as RequestInit)?.method === 'POST'),
    ).toBeUndefined();
  });

  it('accepts a whole-number expiry and clears the hint', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const fetchMock = stubCreateFetch();
    const user = userEvent.setup();
    render(
      <TokenCreateModal wslug="acme" workspaceId="ws-1" open onOpenChange={() => {}} />,
      { wrapper: wrap(qc) },
    );
    await user.type(screen.getByLabelText(/^name$/i), 'CI');
    await user.click(screen.getByLabelText('documents:read'));
    await user.type(screen.getByLabelText(/expires in/i), '7');

    expect(screen.queryByRole('alert')).toBeNull();
    await user.click(screen.getByRole('button', { name: /^create$/i }));
    await waitFor(() => {
      const post = fetchMock.mock.calls.find((c) => (c[1] as RequestInit)?.method === 'POST');
      expect(post).toBeDefined();
      expect(JSON.parse((post![1] as RequestInit).body as string).expires_in_days).toBe(7);
    });
  });

  it('OMITS expires_in_days when the expiry field is left blank', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const fetchMock = stubCreateFetch();
    const user = userEvent.setup();
    render(
      <TokenCreateModal wslug="acme" workspaceId="ws-1" open onOpenChange={() => {}} />,
      { wrapper: wrap(qc) },
    );
    await user.type(screen.getByLabelText(/^name$/i), 'CI');
    await user.click(screen.getByLabelText('documents:read'));
    await user.click(screen.getByRole('button', { name: /^create$/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).not.toHaveProperty('expires_in_days');
  });

  it('the three admin scopes are offered as checkboxes', () => {
    const qc = new QueryClient();
    render(
      <TokenCreateModal wslug="acme" workspaceId="ws-1" open onOpenChange={() => {}} />,
      { wrapper: wrap(qc) },
    );
    for (const scope of ADMIN_SCOPES) {
      expect(screen.getByLabelText(scope)).toBeInTheDocument();
    }
  });

  it('no preset bundles an admin scope', async () => {
    const qc = new QueryClient();
    const user = userEvent.setup();
    render(
      <TokenCreateModal wslug="acme" workspaceId="ws-1" open onOpenChange={() => {}} />,
      { wrapper: wrap(qc) },
    );
    for (const presetName of [/^read-only$/i, /read \+ write/i, /full access/i]) {
      await user.click(screen.getByRole('button', { name: presetName }));
      for (const scope of ADMIN_SCOPES) {
        expect((screen.getByLabelText(scope) as HTMLInputElement).checked).toBe(false);
      }
    }
  });
});
