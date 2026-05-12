export function debounce<TArgs extends unknown[]>(fn: (...args: TArgs) => void, ms: number) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const debounced = (...args: TArgs) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, ms);
  };
  debounced.cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
  debounced.flush = (...args: TArgs) => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    fn(...args);
  };
  return debounced;
}
