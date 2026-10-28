/** Shape shared by every environment file (local, dev, prod). */
export interface Environment {
  /** shown as a banner outside production so test data is never mistaken for real */
  name: 'local' | 'dev' | 'prod';
  production: boolean;
  /** local only: talk to the Firebase emulators instead of a real project */
  useEmulators: boolean;
  functionsRegion: string;
  /**
   * Firebase web config (Firebase console → Project settings → Your apps).
   * Not a secret – access is enforced by security rules – but Admin
   * credentials must NEVER be placed in this app.
   */
  firebase: {
    apiKey: string;
    authDomain: string;
    projectId: string;
    storageBucket: string;
    appId: string;
    messagingSenderId?: string;
  };
}
