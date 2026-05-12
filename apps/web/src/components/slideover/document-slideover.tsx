import { useState, useMemo } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { toast } from 'sonner';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '../ui/sheet.tsx';
import { IconButton } from '../ui/icon-button.tsx';
import { useDocument, useUpdateDocument } from '../../lib/api/documents.ts';
import { useStatuses } from '../../lib/api/statuses.ts';
import { useFields } from '../../lib/api/fields.ts';
import { formatApiError } from '../../lib/api/index.ts';
import { FrontmatterForm } from './frontmatter-form.tsx';

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
          <IconButton label="Close document" onClick={close}>
            <span className="font-mono text-sm">×</span>
          </IconButton>
        </SheetHeader>
        <div className="flex-1 overflow-auto px-6 py-4">
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
  const [pendingKeys, setPendingKeys] = useState<Set<string>>(new Set());

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
    <article className="space-y-4">
      <div className="font-mono text-[11px] text-fg-3">/{doc.slug}</div>
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
      <div className="border-t border-border-light pt-4">
        {/* Body editor lands in Task 16. Placeholder pre block for now. */}
        <pre className="whitespace-pre-wrap font-mono text-sm text-fg">
          {doc.body || '(empty body)'}
        </pre>
      </div>
    </article>
  );
}
