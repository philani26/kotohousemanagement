import { Environment } from './environment.model';

/**
 * LOCAL – `npm start`. Talks to the Java backend on this PC:
 * `docker compose --profile app up` in backend/ (API on port 18081).
 */
export const environment: Environment = {
  name: 'local',
  production: false,
  apiUrl: 'http://localhost:18081',
  hostingProjectId: 'demo-kotahouse',
};
