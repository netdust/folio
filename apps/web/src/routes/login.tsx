import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { Loader2, Mail, Lock } from 'lucide-react';
import type { FormEvent } from 'react';
import { useState } from 'react';
import { ApiError } from '../lib/api/client.ts';
import { useLogin, useMagicLinkRequest } from '../lib/api/auth.ts';
import { Icon } from '../components/ui/icon.tsx';
import { Tabs } from '../components/ui/tabs.tsx';
import { SignupForm } from '../components/onboarding/signup-form.tsx';

type Mode = 'password' | 'magic' | 'signup';

export const Route = createFileRoute('/login')({
  component: LoginPage,
});

function LoginPage() {
  const [mode, setMode] = useState<Mode>('password');
  const [sharedEmail, setSharedEmail] = useState('');
  return (
    <section className="mx-auto max-w-md">
      <h1 className="text-3xl font-medium tracking-tight">Sign in</h1>
      <div className="mt-8">
        <Tabs
          value={mode}
          onChange={setMode}
          items={[
            { value: 'password', label: 'Password' },
            { value: 'magic', label: 'Magic link' },
            { value: 'signup', label: 'Sign up' },
          ]}
        />
      </div>
      <div className="mt-6">
        {mode === 'password' ? <PasswordForm initialEmail={sharedEmail} onEmailChange={setSharedEmail} /> : null}
        {mode === 'magic' ? <MagicForm initialEmail={sharedEmail} onEmailChange={setSharedEmail} /> : null}
        {mode === 'signup' ? <SignupForm initialEmail={sharedEmail} onEmailChange={setSharedEmail} /> : null}
      </div>
    </section>
  );
}

function PasswordForm({ initialEmail, onEmailChange }: { initialEmail: string; onEmailChange: (v: string) => void }) {
  const navigate = useNavigate();
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState('');
  const m = useLogin();
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    m.mutate({ email, password }, { onSuccess: () => navigate({ to: '/' }) });
  };
  return (
    <form className="space-y-4" onSubmit={onSubmit}>
      <FieldWithIcon icon={Mail} label="Email" type="email" value={email} onChange={(v) => { setEmail(v); onEmailChange(v); }} />
      <FieldWithIcon icon={Lock} label="Password" type="password" value={password} onChange={setPassword} />
      <button
        type="submit"
        disabled={m.isPending || !email || !password}
        className="inline-flex w-full items-center justify-center gap-2 rounded-pill bg-primary px-4 py-2.5 text-sm font-medium text-primary-fg hover:opacity-90 transition-opacity duration-fast disabled:opacity-50"
      >
        {m.isPending ? <Icon icon={Loader2} size={14} className="animate-spin" /> : null}
        {m.isPending ? 'Signing in…' : 'Sign in'}
      </button>
      {m.error ? (
        <p className="text-sm text-danger">
          {m.error instanceof ApiError ? 'Invalid credentials.' : 'Something went wrong.'}
        </p>
      ) : null}
    </form>
  );
}

function MagicForm({ initialEmail, onEmailChange }: { initialEmail: string; onEmailChange: (v: string) => void }) {
  const [email, setEmail] = useState(initialEmail);
  const m = useMagicLinkRequest();
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    m.mutate({ email });
  };
  return (
    <form className="space-y-4" onSubmit={onSubmit}>
      <FieldWithIcon icon={Mail} label="Email" type="email" value={email} onChange={(v) => { setEmail(v); onEmailChange(v); }} />
      <button
        type="submit"
        disabled={m.isPending || !email}
        className="inline-flex w-full items-center justify-center gap-2 rounded-pill bg-primary px-4 py-2.5 text-sm font-medium text-primary-fg hover:opacity-90 transition-opacity duration-fast disabled:opacity-50"
      >
        {m.isPending ? <Icon icon={Loader2} size={14} className="animate-spin" /> : null}
        {m.isPending ? 'Sending…' : 'Email me a link'}
      </button>
      {m.isSuccess ? (
        <p className="text-sm text-fg-2">
          Check your inbox. In dev, the link is printed to the server console.
        </p>
      ) : null}
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
