import { getFirebaseConfig } from './env.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.4/firebase-app.js';
import { getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut } from 'https://www.gstatic.com/firebasejs/10.12.4/firebase-auth.js';
import { enableIndexedDbPersistence, enableMultiTabIndexedDbPersistence, getFirestore } from 'https://www.gstatic.com/firebasejs/10.12.4/firebase-firestore.js';

let firebaseApp = null;
let firebaseAuth = null;
let firebaseDb = null;
let firebaseEnabled = null;
let persistenceAttempted = false;

async function enableOfflinePersistence(db) {
  if (persistenceAttempted) return;
  persistenceAttempted = true;
  try {
    await enableIndexedDbPersistence(db);
  } catch (err) {
    if (err?.code === 'failed-precondition') {
      try {
        await enableMultiTabIndexedDbPersistence(db);
      } catch (inner) {
        console.warn('Firestore persistence unavailable', inner);
      }
    } else if (err?.code !== 'unimplemented') {
      console.warn('Firestore persistence unavailable', err);
    }
  }
}

export async function initFirebase() {
  if (firebaseEnabled === false) {
    return { enabled: false, app: null, auth: null, db: null };
  }
  const config = getFirebaseConfig();
  if (!config) {
    firebaseEnabled = false;
    return { enabled: false, app: null, auth: null, db: null };
  }
  firebaseEnabled = true;
  if (!firebaseApp) {
    firebaseApp = initializeApp(config);
    firebaseAuth = getAuth(firebaseApp);
    firebaseDb = getFirestore(firebaseApp);
    await enableOfflinePersistence(firebaseDb);
  }
  return { enabled: true, app: firebaseApp, auth: firebaseAuth, db: firebaseDb };
}

export function isFirebaseConfigured() {
  const config = getFirebaseConfig();
  return Boolean(config?.apiKey && config?.projectId && config?.appId);
}

export async function firebaseSignIn() {
  const { enabled, auth } = await initFirebase();
  if (!enabled || !auth) throw new Error('Firebase is not configured.');
  const provider = new GoogleAuthProvider();
  const res = await signInWithPopup(auth, provider);
  return res.user;
}

export async function firebaseSignOut() {
  const { enabled, auth } = await initFirebase();
  if (!enabled || !auth) return;
  await signOut(auth);
}

export async function firebaseOnAuthStateChanged(callback) {
  const { enabled, auth } = await initFirebase();
  if (!enabled || !auth) return () => {};
  return onAuthStateChanged(auth, callback);
}

export async function firebaseCurrentUser() {
  const { enabled, auth } = await initFirebase();
  if (!enabled || !auth) return null;
  return auth.currentUser;
}

export async function firebaseDbInstance() {
  const { enabled, db } = await initFirebase();
  if (!enabled || !db) return null;
  return db;
}
