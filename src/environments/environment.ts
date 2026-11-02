import { Environment } from './environment.model';

/**
 * LOCAL – `npm start`. Talks to the Java backend on this PC:
 * `docker compose --profile app up` in backend/ (API on port 8081).
 */
export const environment: Environment = {
  name: 'local',
  production: false,
  apiUrl: 'http://localhost:8081',
  hostingProjectId: 'demo-kotahouse',
};
