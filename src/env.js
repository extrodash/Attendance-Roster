export function readEnv(key) {
  if (typeof import.meta !== 'undefined' && import.meta.env && key in import.meta.env) {
    return import.meta.env[key];
  }
  if (typeof window !== 'undefined' && window.__ENV && key in window.__ENV) {
    return window.__ENV[key];
  }
  if (typeof process !== 'undefined' && process.env && key in process.env) {
    return process.env[key];
  }
  return undefined;
}

function readFirebaseEnv(suffix) {
  return (
    readEnv(`VITE_FIREBASE_${suffix}`) ??
    readEnv(`REACT_APP_FIREBASE_${suffix}`) ??
    readEnv(`FIREBASE_${suffix}`)
  );
}

const FALLBACK_FIREBASE_CONFIG = {
  apiKey: "AIzaSyBSI4KjPiUe3heCcJJc_wndY19sUALdnIY",
  authDomain: "attendance-b330b.firebaseapp.com",
  projectId: "attendance-b330b",
  storageBucket: "attendance-b330b.firebasestorage.app",
  messagingSenderId: "549938844146",
  appId: "1:549938844146:web:15d514f842b86a6c9e5b6b",
  measurementId: "G-212XJB5XZZ"
};

export function getFirebaseConfig() {
  const config = {
    apiKey: readFirebaseEnv('API_KEY'),
    authDomain: readFirebaseEnv('AUTH_DOMAIN'),
    projectId: readFirebaseEnv('PROJECT_ID'),
    storageBucket: readFirebaseEnv('STORAGE_BUCKET'),
    messagingSenderId: readFirebaseEnv('MESSAGING_SENDER_ID'),
    appId: readFirebaseEnv('APP_ID'),
    measurementId: readFirebaseEnv('MEASUREMENT_ID')
  };
  if (!config.authDomain && config.projectId) {
    config.authDomain = `${config.projectId}.firebaseapp.com`;
  }
  const hasEnv = config.apiKey && config.projectId && config.appId;
  if (!hasEnv) return FALLBACK_FIREBASE_CONFIG;
  return Object.fromEntries(Object.entries(config).filter(([, value]) => value != null && value !== ''));
}
