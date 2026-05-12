import { useNavigate } from '@tanstack/react-router';
import { Loader2, Mail, Lock, User } from 'lucide-react';
import { useState } from 'react';
import { ApiError } from '../../lib/api/client.ts';
import { apiErrorCode, formatApiError } from '../../lib/api/errors.ts';
import { useRegister } from '../../lib/api/auth.ts';
import { Icon } from '../ui/icon.tsx';

interface Props {
  initialEmail: string;
  onEmailChange: (next: string) => void;
}

export function SignupForm({ initialEmail, onEmailChange }: Props) {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState('');
  const m = useRegister();

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    m.mutate(
      { name, email, password },
      { onSuccess: () => navigate({ to: '/' }) },
    );
  };

  const onEmail = (v: string) => {
    setEmail(v);
    onEmailChange(v);
  };

  const errorMessage = (() => {
    if (!m.error) return null;
    if (m.error instanceof ApiError && apiErrorCode(m.error) === 'EMAIL_TAKEN') {
      return 'An account with this email exists, try signing in.';
    }
    return formatApiError(m.error);
  })();

  return (
    <form className="space-y-4" onSubmit={onSubmit}>
      <FieldWithIcon icon={User} label="Name" type="text" value={name} onChange={setName} />
      <FieldWithIcon icon={Mail} label="Email" type="email" value={email} onChange={onEmail} />
      <FieldWithIcon icon={Lock} label="Password" type="password" value={password} onChange={setPassword} />
      <button
        type="submit"
        disabled={m.isPending || !name || !email || password.length < 8}
        className="inline-flex w-full items-center justify-center gap-2 rounded-pill bg-primary px-4 py-2.5 text-sm font-medium text-primary-fg hover:opacity-90 transition-opacity duration-fast disabled:opacity-50"
      >
        {m.isPending ? <Icon icon={Loader2} size={14} className="animate-spin" /> : null}
        {m.isPending ? 'Creating account…' : 'Create account'}
      </button>
      {errorMessage ? <p className="text-sm text-danger">{errorMessage}</p> : null}
    </form>
  );
}

function FieldWithIcon(props: {
  icon: typeof Mail;
  label: string;
  type: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block">
      <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-fg-3">
        <Icon icon={props.icon} size={14} />
        {props.label}
      </span>
      <input
        type={props.type}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        className="mt-1 w-full rounded-sm border border-border-light bg-transparent px-3 py-2 text-sm"
      />
    </label>
  );
}
