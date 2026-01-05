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

export function getFirebaseConfig() {
  return {
    apiKey: "AIzaSyBSI4KjPiUe3heCcJJc_wndY19sUALdnIY",
    authDomain: "attendance-b330b.firebaseapp.com",
    projectId: "attendance-b330b",
    storageBucket: "attendance-b330b.appspot.com",
    messagingSenderId: "549938844146",
    appId: "1:549938844146:web:15d514f842b86a6c9e5b6b",
  };
}

