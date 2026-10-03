// Which build this is. The local app (npm run dev) has its server: vibe search, project files on disk
// and the font proxy. The online build (npm run build:static, served at www.wouterschreuders.com/fonts/)
// is plain files with no server, so everything that would ask /api/... has to work another way or hide.
// Node scripts import some src/ modules too, and Node has no import.meta.env, hence the fallback.
const env = ((import.meta as { env?: Record<string, unknown> }).env ?? {}) as Record<string, unknown>;

/** True in the online build. */
export const STATIC = env.VITE_STATIC === "1";

/** Where the app is served from, with a trailing slash: "/" locally, "/fonts/" online. */
export const BASE = typeof env.BASE_URL === "string" ? env.BASE_URL : "/";
