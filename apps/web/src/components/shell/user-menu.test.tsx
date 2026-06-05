import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UserMenu } from './user-menu.tsx';

describe('UserMenu', () => {
  it('renders a Workspace settings item when onOpenSettings is provided and fires it on click', async () => {
    const onOpenSettings = vi.fn();
    const user = userEvent.setup();
    render(
      <UserMenu
        trigger={<button type="button">Open menu</button>}
        email="stefan@x"
        onSignOut={() => {}}
        onOpenSettings={onOpenSettings}
      />,
    );
    await user.click(screen.getByRole('button', { name: /open menu/i }));
    await user.click(await screen.findByRole('button', { name: /workspace settings/i }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it('renders the instance "Settings" item when onOpenInstanceSettings is provided and fires it', async () => {
    const onOpenInstanceSettings = vi.fn();
    const user = userEvent.setup();
    render(
      <UserMenu
        trigger={<button type="button">Open menu</button>}
        email="stefan@x"
        onSignOut={() => {}}
        onOpenInstanceSettings={onOpenInstanceSettings}
      />,
    );
    await user.click(screen.getByRole('button', { name: /open menu/i }));
    // Labeled exactly "Settings" (not "Instance settings" / "Workspace settings").
    await user.click(await screen.findByRole('button', { name: /^settings$/i }));
    expect(onOpenInstanceSettings).toHaveBeenCalledTimes(1);
  });

  it('does NOT render the instance Settings item when onOpenInstanceSettings is omitted', async () => {
    const user = userEvent.setup();
    render(
      <UserMenu
        trigger={<button type="button">Open menu</button>}
        email="stefan@x"
        onSignOut={() => {}}
      />,
    );
    await user.click(screen.getByRole('button', { name: /open menu/i }));
    // The popover renders Sign out; the instance "Settings" entry should NOT be present.
    expect(await screen.findByRole('button', { name: /sign out/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^settings$/i })).toBeNull();
  });
});
