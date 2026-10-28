import { Environment } from './environment.model';

/**
 * PROD – the real shop (`npm run deploy:prod`). Web app config of the
 * kotahouse-prod Firebase project. Not a secret: access is enforced by the
 * security rules (see docs/ENVIRONMENTS.md).
 */
export const environment: Environment = {
  name: 'prod',
  production: true,
  useEmulators: false,
  functionsRegion: 'africa-south1',
  firebase: {
    apiKey: 'AIzaSyBADtzpBfKD6oJvJDcQZ8fv3zLshJU6hCU',
    authDomain: 'kotahouse-prod.firebaseapp.com',
    projectId: 'kotahouse-prod',
    storageBucket: 'kotahouse-prod.firebasestorage.app',
    messagingSenderId: '392148085497',
    appId: '1:392148085497:web:2fc3ab703129e405c89028',
  },
};
