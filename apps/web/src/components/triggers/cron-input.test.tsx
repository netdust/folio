import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { CronInput } from './cron-input.tsx';

function Harness({ initial = '' }: { initial?: string }) {
  const [v, setV] = useState(initial);
  return <CronInput value={v} onChange={setV} />;
}

describe('CronInput', () => {
  it('renders a text input', () => {
    render(<Harness />);
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('shows valid indicator on a valid cron, with next-3-fires preview', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByRole('textbox'), '0 9 * * *');
    // Valid indicator
    expect(screen.getByTestId('cron-valid')).toBeInTheDocument();
    expect(screen.queryByTestId('cron-invalid')).not.toBeInTheDocument();
    // Preview line shows three ISO timestamps separated by " · "
    const preview = screen.getByTestId('cron-preview');
    const parts = preview.textContent!.replace(/^Next:\s*/, '').split(' · ');
    expect(parts).toHaveLength(3);
    // Each token roughly matches ISO format YYYY-MM-DDTHH:mm:ss.sssZ
    for (const t of parts) {
      expect(t).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }
  });

  it('shows invalid indicator on a malformed cron, hides preview', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByRole('textbox'), 'not a cron');
    expect(screen.getByTestId('cron-invalid')).toBeInTheDocument();
    expect(screen.queryByTestId('cron-valid')).not.toBeInTheDocument();
    expect(screen.queryByTestId('cron-preview')).not.toBeInTheDocument();
  });

  it('hides both indicators and preview when value is empty', () => {
    render(<Harness />);
    expect(screen.queryByTestId('cron-valid')).not.toBeInTheDocument();
    expect(screen.queryByTestId('cron-invalid')).not.toBeInTheDocument();
    expect(screen.queryByTestId('cron-preview')).not.toBeInTheDocument();
  });

  it('propagates changes via onChange', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const input = screen.getByRole('textbox') as HTMLInputElement;
    await user.type(input, '0 9 * * *');
    expect(input.value).toBe('0 9 * * *');
  });

  it('renders */5 cron as valid with preview', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByRole('textbox'), '*/5 * * * *');
    expect(screen.getByTestId('cron-valid')).toBeInTheDocument();
    expect(screen.getByTestId('cron-preview')).toBeInTheDocument();
  });

  it('forwards placeholder + disabled props', () => {
    render(<CronInput value="" onChange={() => {}} placeholder="cron schedule" disabled />);
    const input = screen.getByPlaceholderText('cron schedule') as HTMLInputElement;
    expect(input.disabled).toBe(true);
  });
});
