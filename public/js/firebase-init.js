// Shared Firebase initialization for all pages.
// Uses the Firebase JS SDK v10+ from a CDN ESM build. The site is auth-gated, so we
// always need Auth; other services are loaded on demand to keep page weight modest.
//
// On localhost we transparently connect to the Emulator Suite (auth :9099,
// firestore :8080, storage :9199, functions :5001) so no code changes are needed
// to switch between dev and prod.

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js';
import {
  getAuth,
  connectAuthEmulator,
} from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js';
import {
  getFirestore,
  initializeFirestore,
  persistentLocalCache,
  connectFirestoreEmulator,
} from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js';
import {
  getStorage,
  connectStorageEmulator,
} from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-storage.js';
import {
  getFunctions,
  connectFunctionsEmulator,
} from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-functions.js';

const IS_LOCAL = location.hostname === 'localhost' || location.hostname === '127.0.0.1';

const firebaseConfig = IS_LOCAL ? {
  apiKey: 'demo-key',
  authDomain: 'demo-compilator.firebaseapp.com',
  projectId: 'demo-compilator',
  storageBucket: 'demo-compilator.appspot.com',
  appId: 'demo-compilator',
} : {
  apiKey: 'AIzaSyBcO7FSeLrBOfnRzpy3UJD6GwGxsi0nGVs',
  authDomain: 'compilator-83816.firebaseapp.com',
  projectId: 'compilator-83816',
  storageBucket: 'compilator-83816.appspot.com',
  messagingSenderId: '1088164732233',
  appId: '1:1088164732233:web:a0227a51ab68db52a10e98',
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = IS_LOCAL
  ? getFirestore(app)
  : initializeFirestore(app, { localCache: persistentLocalCache() });
export const storage = getStorage(app);
export const functions = getFunctions(app);

export const IS_EMULATOR = IS_LOCAL;

if (IS_EMULATOR) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
  connectStorageEmulator(storage, '127.0.0.1', 9199);
  connectFunctionsEmulator(functions, '127.0.0.1', 5001);
}
