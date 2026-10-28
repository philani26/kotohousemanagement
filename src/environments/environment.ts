import { Environment } from './environment.model';

/**
 * LOCAL – `npm start`. Talks only to the Firebase emulators on this PC
 * (`npm run emulators`), so no real data is ever touched.
 */
export const environment: Environment = {
  name: 'local',
  production: false,
  useEmulators: true,
  functionsRegion: 'africa-south1',
  firebase: {
    apiKey: 'demo-key',
    authDomain: 'demo-kotahouse.firebaseapp.com',
    projectId: 'demo-kotahouse',
    storageBucket: 'demo-kotahouse.appspot.com',
    appId: 'demo-app',
  },
};
