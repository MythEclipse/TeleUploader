import { defineConfig } from 'drizzle-kit';

/**
 * P2a — drizzle-kit config.
 *
 * `dbCredentials` is intentionally NOT set. `drizzle-kit generate` never connects
 * to a database (it diffs the schema file), but `drizzle-kit migrate` does —
 * leaving the DSN unset means running `migrate` by accident fails loudly instead
 * of silently pointing at production.
 *
 * Migrations are applied ONLY via `pnpm db:migrate`
 * (src/infrastructure/persistence/drizzle/migrate.ts), which is the sole
 * migration runner. The boot-time auto-migration that ran schema.sql inside a
 * try/catch is removed in P2b: two sources of truth for the schema is precisely
 * the defect this replaces.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/infrastructure/persistence/drizzle/schema.ts',
  out: './drizzle',
  strict: true,
  verbose: true,
});
