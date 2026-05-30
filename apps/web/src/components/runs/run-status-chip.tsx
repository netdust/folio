import { Badge } from '../ui/badge.tsx';

type Tone = 'success' | 'danger' | 'warning' | 'info';
const LABEL_TONE: Record<string, Tone> = {
  running: 'info',
  awaiting_approval: 'warning',
  completed: 'success',
  failed: 'danger',
  rejected: 'danger',
};

export function RunStatusChip({ status }: { status: string }) {
  const label = status.replace(/_/g, ' ');
  const tone = LABEL_TONE[status];
  return tone ? <Badge variant="label" tone={tone}>{label}</Badge> : <Badge variant="medium">{label}</Badge>;
}
