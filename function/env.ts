// The deployed Function's environment: `function:deploy` writes these names and `index.ts` reads
// them. Node only, like `index.ts`.
export const FUNCTION_ENV = {
  databaseUrl: 'MC_DATABASE_URL',
  webhookSecret: 'GITHUB_WEBHOOK_SECRET',
  githubToken: 'GITHUB_TOKEN',
  // Our install (AIF-150): the signing secret of the Linear webhook; unset serves no /linear.
  linearWebhookSecret: 'LINEAR_WEBHOOK_SECRET',
} as const;
