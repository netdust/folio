export function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .normalize('NFKD')
      // biome-ignore lint/suspicious/noMisleadingCharacterClass: deliberate U+0300–U+036F combining-diacritics range — strips accents after NFKD decomposition
      .replace(/[̀-ͯ]/g, '') // strip diacritics
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64)
  );
}
