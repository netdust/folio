const EVENT_NAME = 'folio:open-command-palette';

export function openCommandPalette(): void {
  window.dispatchEvent(new CustomEvent(EVENT_NAME));
}

export function subscribeOpenEvent(handler: () => void): () => void {
  window.addEventListener(EVENT_NAME, handler);
  return () => window.removeEventListener(EVENT_NAME, handler);
}
