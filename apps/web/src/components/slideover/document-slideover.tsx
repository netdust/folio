import { useState, useMemo } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { toast } from 'sonner';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '../ui/sheet.tsx';
import { IconButton } from '../ui/icon-button.tsx';
import { Button } from '../ui/button.tsx';
import { useDocument, useDocuments, useUpdateDocument } from '../../lib/api/documents.ts';
import { useStatuses } from '../../lib/api/statuses.ts';
import { useFields } from '../../lib/api/fields.ts';
import { formatApiError } from '../../lib/api/index.ts';
import { useWorkspace } from '../../lib/api/workspaces.ts';
import { useWorkspaceAiKeys } from '../../lib/api/settings.ts';
import { copyDocumentAsMarkdown } from '../../lib/copy-as-md.ts';
import { FrontmatterForm } from './frontmatter-form.tsx';
import { BodyEditor } from './body-editor.tsx';
import { ModeToggle, type EditorMode } from './mode-toggle.tsx';
import { RawMdEditor } from './raw-md-editor.tsx';

interface Props {
  wslug: string;
  pslug: string;
}

export function DocumentSlideover({ wslug, pslug }: Props) {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { doc?: string };
  const open = !!search.doc;
  const slug = search.doc ?? null;
  const { data: doc, isLoading, error } = useDocument(wslug, pslug, slug);

  const close = () => {
    const { doc: _doc, ...next } = search;
    void navigate({ to: '.', search: next });
  };

  const onCopyMd = async () => {
    if (!slug) return;
    try {
      await copyDocumentAsMarkdown(wslug, pslug, slug);
      toast.success('Copied as Markdown');
    } catch (err) {
      toast.error(formatApiError(err));
    }
  };

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        if (!o) close();
      }}
    >
      <SheetContent width={800} className="h-screen">
        <SheetHeader>
          <SheetTitle>
            {isLoading ? 'Loading…' : error ? 'Failed to load' : doc?.title ?? '—'}
          </SheetTitle>
          <div className="flex items-center gap-2">
            {doc ? (
              <Button variant="secondary" size="sm" onClick={onCopyMd}>
                Copy MD
              </Button>
            ) : null}
            <IconButton label="Close document" onClick={close}>
              <span className="font-mono text-sm">×</span>
            </IconButton>
          </div>
        </SheetHeader>
        <div className="flex-1 min-h-0 overflow-hidden px-6 py-4">
          {slug ? <SlideoverBody wslug={wslug} pslug={pslug} slug={slug} /> : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function SlideoverBody({ wslug, pslug, slug }: { wslug: string; pslug: string; slug: string }) {
  const { data: doc, isLoading, error } = useDocument(wslug, pslug, slug);
  const { data: statuses } = useStatuses(wslug, pslug);
  const { data: fields } = useFields(wslug, pslug);
  const listParams = useMemo(
    () => ({ type: 'work_item' as const, sort: 'updated_at' as const, dir: 'desc' as const }),
    [],
  );
  const update = useUpdateDocument(wslug, pslug, listParams);
  // Documents list — same listParams as useUpdateDocument so React Query dedupes the key
  const { data: docPage } = useDocuments(wslug, pslug, listParams);
  // AI key presence — drives the slash menu's aiConfigured flag
  const { data: workspace } = useWorkspace(wslug);
  const { data: aiKeysData } = useWorkspaceAiKeys(workspace?.id ?? '');
  const aiConfigured = (aiKeysData?.keys ?? []).length > 0;
  const [pendingKeys, setPendingKeys] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<EditorMode>('rich');

  if (isLoading) return <div className="text-fg-3">Loading document…</div>;
  if (error || !doc) return <div className="text-danger">Failed to load document.</div>;

  const onPatch = async (patch: Record<string, unknown>, keys: string[]) => {
    setPendingKeys((prev) => {
      const n = new Set(prev);
      keys.forEach((k) => n.add(k));
      return n;
    });
    try {
      await update.mutateAsync({ slug: doc.slug, patch });
    } catch (err) {
      toast.error(formatApiError(err));
    } finally {
      setPendingKeys((prev) => {
        const n = new Set(prev);
        keys.forEach((k) => n.delete(k));
        return n;
      });
    }
  };

  return (
    <article className="flex h-full flex-col">
      <header className="flex-shrink-0 space-y-3 pb-4">
        <div className="flex items-center justify-between">
          <div className="font-mono text-[11px] text-fg-3">/{doc.slug}</div>
          <ModeToggle mode={mode} onChange={setMode} />
        </div>
        <FrontmatterForm
          type={doc.type}
          status={doc.status}
          statuses={statuses ?? []}
          frontmatter={doc.frontmatter}
          pinnedFields={fields ?? []}
          onStatusCommit={(next) => void onPatch({ status: next }, ['status'])}
          onFrontmatterCommit={(p) => void onPatch({ frontmatter: p }, Object.keys(p))}
          pendingKeys={pendingKeys}
        />
      </header>
      <div className="flex-1 min-h-0 overflow-hidden border-t border-border-light pt-4">
        {mode === 'rich' ? (
          <BodyEditor
            key={`rich-${doc.slug}`}
            value={doc.body}
            onChange={(body) => onPatch({ body }, ['body'])}
            documents={docPage?.data ?? []}
            aiConfigured={aiConfigured}
          />
        ) : (
          <RawMdEditor
            key={`raw-${doc.slug}`}
            value={doc.body}
            onChange={(body) => onPatch({ body }, ['body'])}
          />
        )}
      </div>
    </article>
  );
}
