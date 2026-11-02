import { Environment } from './environment.model';

/**
 * PROD – the real shop (`npm run deploy:prod`).
 * The deploy script refuses to run while apiUrl is not set.
 */
export const environment: Environment = {
  name: 'prod',
  production: true,
  // the production Java backend on AWS Cape Town, once deployed (docs/JAVA-MIGRATION.md)
  apiUrl: 'REPLACE_ME',
  hostingProjectId: 'kotahouse-prod',
};
