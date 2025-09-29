# Attendance-Roster
Track attendance with ease using this HTML site, load your JSON backup and pick up where you left off. Built for SPS Leadership

## Optional Microsoft Graph Sync

Cloud sync is off by default. To enable the OneDrive workflow:

1. Register an app in Azure AD (Entra) and record the **Client ID** and **Tenant ID**.
2. Grant the app delegated `Files.ReadWrite` permission (or a narrower scope that can access the shared JSON file) and approve admin consent.
3. Share the target OneDrive/SharePoint JSON file with each leader, then copy its Microsoft Graph path (for example: `/me/drive/root:/Attendance/attendance_backup.json`).
4. Edit `src/config.js`, set `enabled: true`, and fill in `clientId`, `tenantId` (or `authority`), and `itemResourcePath`.
5. Deploy the updated site. The **Settings → Upload backup** card will display Microsoft sign-in, load, and save buttons.

Leaders sign in with their Microsoft account, press **Load latest from cloud** to pull the shared JSON, and use **Save current to cloud** after recording attendance. The app keeps a local cache so it still works offline; sync buttons are available once the connection is restored.
