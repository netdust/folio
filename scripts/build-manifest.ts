// GENERATED FILE — overwritten by scripts/build.ts on every `bun run build:binary`.
//
// This committed STUB is the dev/uncompiled state: empty records. It exists so
// that app.ts and auto-migrate.ts can STATICALLY import it (a static top-level
// `import … with { type: 'file' }` is what `bun build --compile` reliably embeds;
// a dynamic import is not guaranteed to be embedded). In dev (NODE_ENV !==
// 'production' OR Bun.embeddedFiles.length === 0) the consumers never read these
// records — they take the on-disk serveStatic / import.meta.dir fallback — so the
// empty stub is inert. At build time, scripts/build.ts rewrites this file with the
// real `with { type: 'file' }` imports so --compile sees and embeds every asset.
//
// After a local `build:binary`, restore this stub before committing:
//   git checkout scripts/build-manifest.ts
//
// WEB_ASSETS:  request-pathname ("/index.html", "/assets/index-abc.js") -> embedded file path
// MIGRATIONS:  sql filename ("0000_x.sql") -> embedded file path
// JOURNAL_PATH: embedded path of meta/_journal.json ('' in the stub)

export const WEB_ASSETS: Record<string, string> = {};
export const MIGRATIONS: Record<string, string> = {};
export const JOURNAL_PATH = '';
