/** Shape shared by every environment file (local, dev, prod). */
export interface Environment {
  /** shown as a banner outside production so test data is never mistaken for real */
  name: 'local' | 'dev' | 'prod';
  production: boolean;
  /** address of the Java backend (no trailing slash), e.g. https://api.kotahouse.co.za */
  apiUrl: string;
  /** Firebase Hosting project that serves this web app (until hosting moves to AWS) */
  hostingProjectId: string;
}
