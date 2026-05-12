import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { ApiError } from '../lib/api/client.ts';
import { useLogin, useMagicLinkRequest } from '../lib/api/auth.ts';

export const Route = createFileRoute('/login')({
  component: LoginPage,
});

function LoginPage() {
  const [mode, setMode] = useState<'password' | 'magic'>('password');
  return (
    <section className="mx-auto max-w-md">
      <h1 className="text-3xl font-medium tracking-tight">Sign in</h1>
      <div className="mt-8 flex gap-2 text-sm">
        <button
          type="button"
          onClick={() => setMode('password')}
          className={`rounded-sm px-3 py-1.5 ${
            mode === 'password' ? 'bg-card text-fg' : 'text-fg-2 hover:bg-card'
          }`}
        >
          Password
        </button>
        <button
          type="button"
          onClick={() => setMode('magic')}
          className={`rounded-sm px-3 py-1.5 ${
            mode === 'magic' ? 'bg-card text-fg' : 'text-fg-2 hover:bg-card'
          }`}
        >
          Magic link
        </button>
      </div>
      <div className="mt-6">{mode === 'password' ? <PasswordForm /> : <MagicForm />}</div>
    </section>
  );
}

function PasswordForm() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const m = useLogin();
  return (
    <div className="space-y-4">
      <Field label="Email" type="email" value={email} onChange={setEmail} />
      <Field label="Password" type="password" value={password} onChange={setPassword} />
      <button
        type="button"
        onClick={() => m.mutate({ email, password }, { onSuccess: () => navigate({ to: '/' }) })}
        disabled={m.isPending}
        className="w-full rounded-pill bg-primary px-4 py-2.5 text-sm font-medium text-primary-fg hover:opacity-90 transition-opacity duration-fast disabled:opacity-50"
      >
        {m.isPending ? 'Signing in…' : 'Sign in'}
      </button>
      {m.error ? (
        <p className="text-sm text-danger">
          {m.error instanceof ApiError ? 'Invalid credentials.' : 'Something went wrong.'}
        </p>
      ) : null}
    </div>
  );
}

function MagicForm() {
  const [email, setEmail] = useState('');
  const m = useMagicLinkRequest();
  return (
    <div className="space-y-4">
      <Field label="Email" type="email" value={email} onChange={setEmail} />
      <button
        type="button"
        onClick={() => m.mutate({ email })}
        disabled={m.isPending}
        className="w-full rounded-pill bg-primary px-4 py-2.5 text-sm font-medium text-primary-fg hover:opacity-90 transition-opacity duration-fast disabled:opacity-50"
      >
        {m.isPending ? 'Sending…' : 'Email me a link'}
      </button>
      {m.isSuccess ? (
        <p className="text-sm text-fg-2">
          Check your inbox. In dev, the link is printed to the server console.
        </p>
      ) : null}
    </div>
  );
}

function Field(props: {
  label: string;
  type: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block">
      <span className="block text-xs font-semibold uppercase tracking-wide text-fg-3">
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
