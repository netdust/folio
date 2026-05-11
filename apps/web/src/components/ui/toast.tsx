import { Toaster as SonnerToaster, toast } from 'sonner';

export function Toaster() {
  return (
    <SonnerToaster
      position="bottom-right"
      offset={16}
      visibleToasts={3}
      duration={3500}
      toastOptions={{
        className: 'bg-content shadow-popover rounded-lg p-3 text-sm text-fg',
        descriptionClassName: 'text-fg-2',
        unstyled: false,
      }}
    />
  );
}

export { toast };
