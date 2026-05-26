import { createFileRoute, notFound } from '@tanstack/react-router';
import { Button } from '../components/ui/button.tsx';
import { IconButton } from '../components/ui/icon-button.tsx';
import { Pill } from '../components/ui/pill.tsx';
import { Badge, labelTone } from '../components/ui/badge.tsx';
import { Chip, ChipAdd, FilterChipValue } from '../components/ui/chip.tsx';
import { Avatar } from '../components/ui/avatar.tsx';
import { Kbd } from '../components/ui/kbd.tsx';
import { ThemeToggle } from '../components/ui/theme-toggle.tsx';
import { Dialog, DialogTrigger, DialogContent, DialogTitle, DialogDescription } from '../components/ui/dialog.tsx';
import { Sheet, SheetTrigger, SheetContent } from '../components/ui/sheet.tsx';
import { toast } from '../components/ui/toast.tsx';
import { Shell } from '../components/shell/shell.tsx';
import { Rail } from '../components/shell/rail.tsx';
import { MainFrame, FrameTab } from '../components/shell/main-frame.tsx';
import { RightPanel } from '../components/shell/right-panel.tsx';
import { RailCollapseToggle } from '../components/shell/rail-collapse-toggle.tsx';
import { useState } from 'react';

export const Route = createFileRoute('/dev/design-system')({
  beforeLoad: () => {
    if (!import.meta.env.DEV) throw notFound();
  },
  component: DesignSystem,
});

function DesignSystem() {
  return (
    <div className="min-h-screen bg-shell text-fg px-8 py-10">
      <header className="mx-auto max-w-5xl flex items-center gap-4 mb-10">
        <h1 className="text-2xl font-medium tracking-tight">Design system</h1>
        <span className="font-mono text-[11px] text-fg-3">dev only · v0</span>
        <span className="flex-1" />
        <ThemeToggle />
      </header>

      <Section title="Buttons">
        <Row>
          <Button variant="primary">Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger">Danger</Button>
          <Button loading>Loading</Button>
          <Button disabled>Disabled</Button>
        </Row>
        <Row>
          <Button size="sm">Small</Button>
          <Button size="md">Medium</Button>
          <Button size="lg">Large</Button>
        </Row>
      </Section>

      <Section title="Icon buttons">
        <Row>
          <IconButton size="sm" label="Edit"><Icon path="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /></IconButton>
          <IconButton size="md" label="Close"><Icon path="M18 6L6 18M6 6l12 12" /></IconButton>
          <IconButton size="lg" label="Search"><Icon path="M21 21l-4.35-4.35M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16z" /></IconButton>
          <IconButton size="md" label="Active" active><Icon path="M5 13l4 4L19 7" /></IconButton>
        </Row>
      </Section>

      <Section title="Status pills">
        <Row>
          <Pill category="backlog" label="Backlog" />
          <Pill category="unstarted" label="Todo" />
          <Pill category="started" label="In progress" />
          <Pill category="completed" label="Done" />
          <Pill category="cancelled" label="Cancelled" />
        </Row>
      </Section>

      <Section title="Badges">
        <Row>
          <Badge variant="high">High</Badge>
          <Badge variant="medium">Medium</Badge>
          <Badge variant="low">Low</Badge>
        </Row>
        <Row>
          {['curation', 'deadline', 'research', 'logistics', 'press'].map((l) => (
            <Badge key={l} variant="label" tone={labelTone(l)}>{l}</Badge>
          ))}
        </Row>
      </Section>

      <Section title="Chips">
        <Row>
          <Chip>project-a</Chip>
          <Chip muted>removed</Chip>
          <Chip onClick={() => {}}>clickable</Chip>
          <Chip mono>list_documents</Chip>
          <Chip muted mono>deadbeef·removed</Chip>
        </Row>
        <Row>
          <FilterChipValue filterKey="status" value="is not Done" />
          <FilterChipValue filterKey="assignee" value="anyone" />
          <ChipAdd />
        </Row>
      </Section>

      <Section title="Avatars">
        <Row>
          <Avatar name="Stefan Vermaercke" size="xs" />
          <Avatar name="Ana Vermeulen" size="sm" />
          <Avatar name="Marc De Bruyne" size="md" />
        </Row>
      </Section>

      <Section title="Keyboard hints">
        <Row>
          <Kbd>⌘K</Kbd>
          <Kbd>Esc</Kbd>
          <Kbd>⌘\</Kbd>
          <Kbd>⌘⇧C</Kbd>
        </Row>
      </Section>

      <Section title="Toast">
        <Row>
          <Button variant="secondary" onClick={() => toast.success('Saved.')}>Success</Button>
          <Button variant="secondary" onClick={() => toast.error('Failed to update — rolled back.')}>Error</Button>
          <Button variant="secondary" onClick={() => toast('Copied as Markdown.')}>Plain</Button>
        </Row>
      </Section>

      <Section title="Dialog">
        <Row>
          <Dialog>
            <DialogTrigger asChild><Button>Open dialog</Button></DialogTrigger>
            <DialogContent>
              <DialogTitle>Confirm delete</DialogTitle>
              <DialogDescription>This action cannot be undone.</DialogDescription>
              <div className="mt-6 flex justify-end gap-2">
                <Button variant="ghost">Cancel</Button>
                <Button variant="danger">Delete</Button>
              </div>
            </DialogContent>
          </Dialog>
        </Row>
      </Section>

      <Section title="Sheet (800px slideover)">
        <Row>
          <Sheet>
            <SheetTrigger asChild><Button>Open sheet</Button></SheetTrigger>
            <SheetContent>
              <div className="p-6">
                <h2 className="text-xl font-medium tracking-tight">Document slideover preview</h2>
                <p className="mt-2 text-sm text-fg-2">800px wide. Closes on Esc or click-outside.</p>
              </div>
            </SheetContent>
          </Sheet>
        </Row>
      </Section>

      <Section title="Shell preview (try collapsing the rail)">
        <ShellPreview />
      </Section>
    </div>
  );
}

function ShellPreview() {
  const [panelOpen, setPanelOpen] = useState(false);
  const navIcon = (path: string) => <Icon path={path} />;
  return (
    <div className="h-[480px] -mx-4">
      <Shell
        rail={
          <Rail
            brand={{ mark: 'F', label: 'Folio' }}
            workspace={{ mark: 'G', name: 'Galerie Sint-Jan', onSwitch: () => toast('Switch workspace clicked.') }}
            primary={[
              { id: 'home',  label: 'Home',       icon: navIcon('M3 12l9-9 9 9M5 10v10h14V10') },
              { id: 'work',  label: 'Work items', icon: navIcon('M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01'), active: true },
              { id: 'board', label: 'Board',      icon: navIcon('M3 3h18v18H3zM9 3v18M15 3v18') },
              { id: 'wiki',  label: 'Wiki',       icon: navIcon('M4 19.5A2.5 2.5 0 0 1 6.5 17H20M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z') },
            ]}
            tools={[
              { id: 'search', label: 'Search', kbd: '⌘K', icon: navIcon('M21 21l-4.35-4.35M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16z') },
            ]}
            account={[
              { id: 'settings', label: 'Settings', icon: navIcon('M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z') },
            ]}
            user={{ name: 'Stefan Vermaercke' }}
          />
        }
        main={
          <MainFrame
            title="Exhibitions"
            subMeta="galerie-sint-jan / exhibitions · 14 work items"
            actions={
              <>
                <Button variant="secondary" size="md" onClick={() => setPanelOpen((v) => !v)}>
                  {panelOpen ? 'Hide panel' : 'Show panel'}
                </Button>
                <Button variant="primary" size="md">+ New</Button>
                <RailCollapseToggle />
              </>
            }
            tabs={
              <>
                <FrameTab active>All work items</FrameTab>
                <FrameTab>Board</FrameTab>
                <FrameTab>Up next</FrameTab>
              </>
            }
            toolbar={
              <>
                <FilterChipValue filterKey="status" value="is not Done" />
                <ChipAdd />
                <div className="flex-1" />
                <span className="font-mono text-[11px] text-fg-3">sorted by updated_at ↓</span>
              </>
            }
          >
            <div className="space-y-2 py-2 text-sm">
              <p className="text-fg-2">List view content lands in Plan C (Phase 1 frontend).</p>
              <p className="text-fg-3 text-xs">For now, primitives render here so designers can review them in context.</p>
            </div>
          </MainFrame>
        }
        panel={
          <RightPanel open={panelOpen} activeTab="context" onTabChange={() => {}} showAiTab={false}>
            <div className="space-y-3 text-sm">
              <div className="text-[15px] font-medium">Confirm artists for Spring '26 group show</div>
              <div className="font-mono text-[10px] text-fg-3">work_item · spring-26-artists</div>
              <Pill category="started" label="In progress" />
              <p className="text-fg-2">Right panel content lands in Plan C. For now it shows the locked tab chrome.</p>
            </div>
          </RightPanel>
        }
      />
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mx-auto max-w-5xl mb-10">
      <h2 className="text-[10px] font-semibold uppercase tracking-wider text-fg-3 mb-3">{title}</h2>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return <div className="flex items-center flex-wrap gap-2.5">{children}</div>;
}

function Icon({ path }: { path: string }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {path.split('M').filter(Boolean).map((p, i) => (
        <path key={i} d={`M${p}`} />
      ))}
    </svg>
  );
}
