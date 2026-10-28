import { Environment } from './environment.model';

/**
 * PROD – the real shop (`npm run deploy:prod`). Paste the web app config of
 * the PRODUCTION Firebase project here (see docs/ENVIRONMENTS.md).
 */
export const environment: Environment = {
  name: 'prod',
  production: true,
  useEmulators: false,
  functionsRegion: 'africa-south1',
  firebase: {
    apiKey: 'REPLACE_ME',
    authDomain: 'kotahouse-prod.firebaseapp.com',
    projectId: 'kotahouse-prod',
    storageBucket: 'kotahouse-prod.firebasestorage.app',
    appId: 'REPLACE_ME',
  },
};
