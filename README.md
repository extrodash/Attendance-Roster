# Attendance-Roster
Track attendance with ease using this HTML site, load your JSON backup and pick up where you left off. Built for SPS Leadership

## Firebase Cloud Sync (Optional)

Cloud sync is off until Firebase env vars are provided. No default Firebase project is bundled, so the app runs local-only by default and keeps the JSON backup workflow.

### Setup

1. Create a Firebase project and add a Web app.
2. Enable **Authentication → Google** (or adjust `firebase.js` to match your provider).
3. Create a Firestore database and apply rules from `firestore.rules`.
4. Provide Firebase config values via environment variables:

```
VITE_FIREBASE_API_KEY=...
VITE_FIREBASE_AUTH_DOMAIN=...
VITE_FIREBASE_PROJECT_ID=...
VITE_FIREBASE_STORAGE_BUCKET=...
VITE_FIREBASE_MESSAGING_SENDER_ID=...
VITE_FIREBASE_APP_ID=...
VITE_FIREBASE_MEASUREMENT_ID=... (optional)
```

If you deploy the static HTML without a bundler, create `assets/env.js` (not committed) with:

```js
window.__ENV = {
  VITE_FIREBASE_API_KEY: '...',
  VITE_FIREBASE_AUTH_DOMAIN: '...',
  VITE_FIREBASE_PROJECT_ID: '...',
  VITE_FIREBASE_STORAGE_BUCKET: '...',
  VITE_FIREBASE_MESSAGING_SENDER_ID: '...',
  VITE_FIREBASE_APP_ID: '...'
};
```

### Use

- Open **Settings → Cloud sync (Firebase)**.
- Sign in, then **Create team** or **Join team** using a shared team ID.
- On first connection, choose how to migrate:
  - Upload this device’s data to seed the cloud.
  - Replace local data with the cloud copy.
  - Cancel.
- Only team leads can overwrite cloud data during migration.
- Use **Sync mode** to toggle Local-only vs Firebase.

### Backup

JSON download/upload remains available as a safety net.


### Since last work block

Firebase is now operational. Users are able to sign in with Google account, create and join teams.

Current issue: Firebase might be lagging behind, resulting in there somehow now being two teams merged into the same team called "Attendance."

Considering adding a feature for using different backups

Figure out how to make team sync make more sense
