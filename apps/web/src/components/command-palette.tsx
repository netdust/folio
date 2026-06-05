import { useNavigate, useRouterState } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';
import { Dialog, DialogContent } from './ui/dialog.tsx';
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from './ui/command.tsx';
import { useDocuments, useCreateDocument } from '../lib/api/documents.ts';
import { useProjects } from '../lib/api/projects.ts';
import { useWorkspaces } from '../lib/api/workspaces.ts';
import { matches } from '../lib/command-registry.ts';
import { getResolvedTheme, setTheme } from '../lib/theme.ts';
import { subscribeOpenEvent } from '../lib/command-palette-bus.ts';
import { agentPanelBus } from '../lib/agent-panel-bus.ts';

function getKeyMod(): 'metaKey' | 'ctrlKey' {
  if (typeof navigator === 'undefined') return 'ctrlKey';
  return navigator.platform.toLowerCase().includes('mac') ? 'metaKey' : 'ctrlKey';
}

function useToggleTheme(): () => void {
  return () => {
    const next = getResolvedTheme() === 'dark' ? 'light' : 'dark';
    setTheme(next);
  };
}

interface RouteCtx {
  workspaceSlug: string | null;
  projectSlug: string | null;
}

function parseRouteCtx(pathname: string): RouteCtx {
  const m = pathname.match(/^\/w\/([^/]+)(?:\/p\/([^/]+))?/);
  return {
    workspaceSlug: m?.[1] ?? null,
    projectSlug: m?.[2] ?? null,
  };
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const navigate = useNavigate();
  const routerState = useRouterState();
  const pathname = routerState.location.pathname;
  const ctx = useMemo(() => parseRouteCtx(pathname), [pathname]);
  const toggleTheme = useToggleTheme();

  // Global Cmd-K / Ctrl-K listener
  useEffect(() => {
    const keyMod = getKeyMod();
    const onKey = (e: KeyboardEvent) => {
      const mod = (e as unknown as Record<string, boolean>)[keyMod];
      if (mod && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    return subscribeOpenEvent(() => setOpen(true));
  }, []);

  // Reset query when palette closes
  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  const { data: workspaces } = useWorkspaces();
  const { data: projects } = useProjects(ctx.workspaceSlug ?? '');

  const listParams = useMemo(() => ({ type: 'work_item' as const, limit: 100 }), []);
  const { data: docPage } = useDocuments(
    ctx.workspaceSlug ?? '',
    ctx.projectSlug ?? '',
    listParams,
  );

  const create = useCreateDocument(ctx.workspaceSlug ?? '', ctx.projectSlug ?? '');

  const close = () => setOpen(false);

  const onCreate = async (type: 'work_item' | 'page') => {
    if (!ctx.workspaceSlug || !ctx.projectSlug) return;
    const doc = await create.mutateAsync({
      type,
      title: type === 'work_item' ? 'New work item' : 'Untitled page',
    });
    close();
    void navigate({
      to: type === 'work_item'
        ? '/w/$wslug/p/$pslug/work-items'
        : '/w/$wslug/p/$pslug/wiki',
      params: { wslug: ctx.workspaceSlug, pslug: ctx.projectSlug },
      search: { doc: doc.slug },
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-[560px] p-0">
        <Command shouldFilter={false}>
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder="Type a command…"
          />
          <CommandList>
            <CommandEmpty>No matches.</CommandEmpty>

            {ctx.workspaceSlug && ctx.projectSlug ? (
              <CommandGroup heading="Create">
                {matches({ label: 'New work item' }, query) ? (
                  <CommandItem onSelect={() => { void onCreate('work_item'); }}>
                    New work item
                  </CommandItem>
                ) : null}
                {matches({ label: 'New page' }, query) ? (
                  <CommandItem onSelect={() => { void onCreate('page'); }}>
                    New page
                  </CommandItem>
                ) : null}
              </CommandGroup>
            ) : null}

            {ctx.workspaceSlug && ctx.projectSlug && docPage?.data ? (
              <CommandGroup heading="Open document">
                {docPage.data
                  .filter((d) => matches({ label: d.title }, query))
                  .slice(0, 8)
                  .map((d) => (
                    <CommandItem
                      key={d.id}
                      onSelect={() => {
                        close();
                        void navigate({
                          to: pathname.includes('/wiki')
                            ? '/w/$wslug/p/$pslug/wiki'
                            : '/w/$wslug/p/$pslug/work-items',
                          params: {
                            wslug: ctx.workspaceSlug!,
                            pslug: ctx.projectSlug!,
                          },
                          search: { doc: d.slug },
                        });
                      }}
                    >
                      <span className="flex-1">{d.title}</span>
                      <span className="font-mono text-[11px] text-fg-3">/{d.slug}</span>
                    </CommandItem>
                  ))}
              </CommandGroup>
            ) : null}

            {ctx.workspaceSlug && projects && projects.length > 1 ? (
              <CommandGroup heading="Switch project">
                {projects
                  .filter((p) => matches({ label: p.name }, query))
                  .map((p) => (
                    <CommandItem
                      key={p.id}
                      onSelect={() => {
                        close();
                        void navigate({
                          to: '/w/$wslug/p/$pslug/work-items',
                          params: { wslug: ctx.workspaceSlug!, pslug: p.slug },
                        });
                      }}
                    >
                      {p.name}
                    </CommandItem>
                  ))}
              </CommandGroup>
            ) : null}

            {workspaces && workspaces.length > 1 ? (
              <CommandGroup heading="Switch workspace">
                {workspaces
                  .filter((m) => matches({ label: m.workspace.name }, query))
                  .map((m) => (
                    <CommandItem
                      key={m.workspace.id}
                      onSelect={() => {
                        close();
                        void navigate({
                          to: '/w/$wslug',
                          params: { wslug: m.workspace.slug },
                        });
                      }}
                    >
                      {m.workspace.name}
                    </CommandItem>
                  ))}
              </CommandGroup>
            ) : null}

            <CommandGroup heading="Tools">
              {matches({ label: 'Toggle operator' }, query) ? (
                <CommandItem
                  onSelect={() => {
                    close();
                    agentPanelBus.toggle();
                  }}
                >
                  Toggle operator
                </CommandItem>
              ) : null}
              {matches({ label: 'Toggle theme' }, query) ? (
                <CommandItem
                  onSelect={() => {
                    toggleTheme();
                    close();
                  }}
                >
                  Toggle theme
                </CommandItem>
              ) : null}
            </CommandGroup>
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
