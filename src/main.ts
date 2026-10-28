import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';
import { environment } from './environments/environment';

if (environment.name !== 'prod') document.title = `[${environment.name.toUpperCase()}] ${document.title}`;

if (!environment.useEmulators && environment.firebase.apiKey.startsWith('REPLACE')) {
  // A build for dev/prod without its Firebase config would otherwise show a blank page.
  document.body.innerHTML = `<div style="font: 16px system-ui; max-width: 520px; margin: 4rem auto; padding: 1rem">
    <h1>Kota House is not configured</h1>
    <p>This <b>${environment.name}</b> build has no Firebase config. Paste the web app config into
    <code>src/environments/environment.${environment.name}.ts</code> (see docs/ENVIRONMENTS.md) and rebuild.</p></div>`;
} else {
  bootstrapApplication(App, appConfig).catch((err) => console.error(err));
}
