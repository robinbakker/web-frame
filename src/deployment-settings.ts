// Deployment controls are supplied by the launcher (Docker Compose, docker run,
// or a local shell). Application settings remain editable through .env/the UI.
export const DEPLOYMENT_KEYS = [
  'SERVER_HOST', 'SERVER_PORT', 'SERVER_TLS_CERT', 'SERVER_TLS_KEY',
  'PLAYWRIGHT_BROWSERS_PATH', 'NODE_ENV',
] as const;
