import { useMutation } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { api, ApiError } from '../lib/api.ts';

export const Route = createFileRoute('/login')({
  component: LoginPage,
});

function LoginPage() {
  const [mode, setMode] = useState<'password' | 'magic'>('password');
  return (
    <section className="mx-auto max-w-md">
      <h1 className="font-display text-4xl tracking-tight">Sign in</h1>
      <div className="mt-8 flex gap-2 text-sm">
        <button
          type="button"
          onClick={() => setMode('password')}
          className={`rounded px-3 py-1.5 ${
            mode === 'password' ? 'bg-paper-200 dark:bg-paper-800' : 'text-muted'
          }`}
        >
          Password
        </button>
        <button
          type="button"
          onClick={() => setMode('magic')}
          className={`rounded px-3 py-1.5 ${
            mode === 'magic' ? 'bg-paper-200 dark:bg-paper-800' : 'text-muted'
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
  const m = useMutation({
    mutationFn: () => api.post('/api/auth/login', { email, password }),
    onSuccess: () => navigate({ to: '/' }),
  });

  return (
    <div className="space-y-4">
      <Field label="Email" type="email" value={email} onChange={setEmail} />
      <Field label="Password" type="password" value={password} onChange={setPassword} />
      <button
        type="button"
        onClick={() => m.mutate()}
        disabled={m.isPending}
        className="w-full rounded bg-paper-900 px-4 py-2.5 text-sm text-paper-50 dark:bg-paper-100 dark:text-paper-900"
      >
        {m.isPending ? 'Signing in…' : 'Sign in'}
      </button>
      {m.error ? (
        <p className="text-sm text-red-600">
          {m.error instanceof ApiError ? 'Invalid credentials.' : 'Something went wrong.'}
        </p>
      ) : null}
    </div>
  );
}

function MagicForm() {
  const [email, setEmail] = useState('');
  const m = useMutation({
    mutationFn: () => api.post('/api/auth/magic/request', { email }),
  });

  return (
    <div className="space-y-4">
      <Field label="Email" type="email" value={email} onChange={setEmail} />
      <button
        type="button"
        onClick={() => m.mutate()}
        disabled={m.isPending}
        className="w-full rounded bg-paper-900 px-4 py-2.5 text-sm text-paper-50 dark:bg-paper-100 dark:text-paper-900"
      >
        {m.isPending ? 'Sending…' : 'Email me a link'}
      </button>
      {m.isSuccess ? (
        <p className="text-sm text-muted">
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
      <span className="block text-xs uppercase tracking-wide text-muted">{props.label}</span>
      <input
        type={props.type}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        className="mt-1 w-full rounded border border-default bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-current"
      />
    </label>
  );
}
