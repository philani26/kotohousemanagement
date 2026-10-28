import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from './auth.service';

// Note: inject() must run before the first await – injection context ends there.

/** Signed in and linked to a business. */
export const staffGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  await auth.ready;
  if (!auth.user()) return router.parseUrl('/login');
  if (!auth.businessId()) return router.parseUrl('/setup');
  return true;
};

/** Owner-only areas. The same restriction is enforced by security rules and functions. */
export const ownerGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  await auth.ready;
  return auth.isOwner() ? true : router.parseUrl('/pos');
};

export const signedOutGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  await auth.ready;
  return auth.user() ? router.parseUrl('/') : true;
};

export const homeRedirect: CanActivateFn = async () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  await auth.ready;
  return router.parseUrl(auth.isOwner() ? '/dashboard' : '/pos');
};
