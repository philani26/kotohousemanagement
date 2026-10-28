import { Injectable } from '@angular/core';
import { initializeApp } from 'firebase/app';
import { connectAuthEmulator, getAuth } from 'firebase/auth';
import {
  connectFirestoreEmulator,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
} from 'firebase/firestore';
import { connectFunctionsEmulator, getFunctions } from 'firebase/functions';
import { connectStorageEmulator, getStorage } from 'firebase/storage';
import { environment } from '../../environments/environment';

/** Single place where the Firebase SDKs are initialised. */
@Injectable({ providedIn: 'root' })
export class FirebaseService {
  readonly app = initializeApp(environment.firebase);
  readonly auth = getAuth(this.app);
  /** Offline cache keeps screens usable on a weak mobile connection. */
  readonly db = initializeFirestore(this.app, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
  });
  readonly functions = getFunctions(this.app, environment.functionsRegion);
  readonly storage = getStorage(this.app);

  constructor() {
    if (environment.useEmulators) {
      connectAuthEmulator(this.auth, 'http://127.0.0.1:9099', { disableWarnings: true });
      connectFirestoreEmulator(this.db, '127.0.0.1', 8085); // 8080 is often taken by Docker
      connectFunctionsEmulator(this.functions, '127.0.0.1', 5001);
      connectStorageEmulator(this.storage, '127.0.0.1', 9199);
    }
  }
}
