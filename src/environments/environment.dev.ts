import { Environment } from './environment.model';

/**
 * DEV – the online test shop (`npm run start:dev`, `npm run deploy:dev`).
 * Its own backend and database, separate from production (see docs/ENVIRONMENTS.md).
 */
export const environment: Environment = {
  name: 'dev',
  production: true,
  // the dev Java backend once it is deployed (docs/JAVA-MIGRATION.md)
  apiUrl: 'REPLACE_ME',
  hostingProjectId: 'kotahouse-dev',
};
