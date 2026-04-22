// No-op mock for `server-only` in the Vitest Node environment.
// The real package throws when the "react-server" export condition is absent
// (i.e. any non-server-component bundler context).  Vitest uses Node, not a
// React bundler, so we replace it with an empty module via the resolve alias
// in vitest.config.ts.
export default {};
