import { Environment } from './environment.model';

/**
 * PROD – the real shop (`npm run deploy:prod`).
 * The deploy script refuses to run while apiUrl is not set.
 */
export const environment: Environment = {
  name: 'prod',
  production: true,
  // the Java backend on Google Cloud Run, Johannesburg (africa-south1)
  apiUrl: 'https://kotahouse-api-392148085497.africa-south1.run.app',
  hostingProjectId: 'kotahouse-prod',
};
