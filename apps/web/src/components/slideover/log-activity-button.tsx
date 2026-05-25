import { useState } from 'react';
import { Activity } from 'lucide-react';
import { toast } from 'sonner';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover.tsx';
import { Button } from '../ui/button.tsx';
import { Icon } from '../ui/icon.tsx';
import { useLogActivity } from '../../lib/api/events.ts';
import { formatApiError } from '../../lib/api/index.ts';

interface Props {
  wslug: string;
  pslug: string;
  slug: string;
}

export function LogActivityButton({ wslug, pslug, slug }: Props) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const log = useLogActivity(wslug, pslug);

  const submit = async () => {
    const trimmed = note.trim();
    if (!trimmed) return;
    try {
      await log.mutateAsync({ slug, note: trimmed });
      setNote('');
      setOpen(false);
      toast.success('Activity logged');
    } catch (err) {
      toast.error(formatApiError(err));
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Log activity"
          title="Log activity"
          className="grid h-6 w-6 place-items-center rounded text-fg-3 hover:bg-card hover:text-fg-2"
        >
          <Icon icon={Activity} size={14} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[280px] p-2.5">
        <textarea
          autoFocus
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="What happened? (e.g. Called, left voicemail)"
          rows={3}
          className="block w-full rounded-md border border-border-light bg-shell px-2 py-1.5 text-sm text-fg input-focus resize-none"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void submit(); }
          }}
        />
        <div className="mt-2 flex items-center justify-between">
          <span className="text-[10px] text-fg-3">⌘↵ to log</span>
          <Button type="button" onClick={submit} disabled={log.isPending || !note.trim()}>
            {log.isPending ? 'Logging…' : 'Log'}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
