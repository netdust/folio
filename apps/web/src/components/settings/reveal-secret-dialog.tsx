import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '../ui/dialog.tsx';
import { Button } from '../ui/button.tsx';

interface Props {
  /** The once-only plaintext secret to reveal; `null` keeps the dialog closed. */
  secret: string | null;
  /** Called when the user dismisses (Done / overlay / Esc) — clear the secret. */
  onClose: () => void;
  title?: string;
}

/**
 * "Copy this token once" reveal — the secret is shown a single time, with a
 * copy-to-clipboard button. Shared by BOTH token tabs' rotate flows (the JSX was
 * byte-identical across them). The token-create dialog has its own reveal pane
 * bound to its create-form lifecycle (different title + reset semantics), so it
 * is intentionally NOT routed through here.
 */
export function RevealSecretDialog({ secret, onClose, title = 'Token rotated' }: Props) {
  const [copied, setCopied] = useState(false);

  async function copySecret() {
    if (!secret) return;
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('Copy failed — select the token manually');
    }
  }

  function handleClose() {
    setCopied(false);
    onClose();
  }

  return (
    <Dialog
      open={secret !== null}
      onOpenChange={(open) => {
        if (!open) handleClose();
      }}
    >
      <DialogContent>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>
          This is the only time you&apos;ll see this token. Copy it now and store it
          somewhere safe.
        </DialogDescription>
        <div className="mt-4 rounded-md border border-border-light bg-shell p-2">
          <code className="block break-all font-mono text-xs text-fg">{secret}</code>
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="secondary" onClick={copySecret}>
            {copied ? (
              <>
                <Check size={14} />
                Copied
              </>
            ) : (
              <>
                <Copy size={14} />
                Copy
              </>
            )}
          </Button>
          <Button onClick={handleClose}>Done</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
