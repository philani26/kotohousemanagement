import { Environment } from './environment.model';

/**
 * DEV – the online test shop (`npm run start:dev`, `npm run deploy:dev`).
 * A separate Firebase project from production: its own logins, data and
 * settings. Paste the web app config of the DEV project here (see docs/ENVIRONMENTS.md).
 */
export const environment: Environment = {
  name: 'dev',
  production: true,
  useEmulators: false,
  functionsRegion: 'africa-south1',
  firebase: {
    apiKey: 'REPLACE_ME',
    authDomain: 'kotahouse-dev.firebaseapp.com',
    projectId: 'kotahouse-dev',
    storageBucket: 'kotahouse-dev.firebasestorage.app',
    appId: 'REPLACE_ME',
  },
};
