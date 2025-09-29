// Configuration for optional Microsoft Graph sync.
// Set `enabled` to true and fill in all required fields to activate.
export const graphSyncConfig = {
  // Toggle to enable Microsoft Graph syncing.
  enabled: false,

  // Azure AD app (client) ID from Entra portal.
  clientId: '',

  // Tenant (directory) ID. Leave blank if you prefer to supply `authority` directly.
  tenantId: '',

  // Optional explicit authority URL, e.g. `https://login.microsoftonline.com/<tenantId>`.
  authority: '',

  // Scopes required for OneDrive file access. Defaults to Files.ReadWrite when left empty.
  scopes: ['Files.ReadWrite'],

  // Microsoft Graph resource path for the JSON file.
  // Example personal OneDrive path: '/me/drive/root:/Attendance/attendance_backup.json'
  // Example SharePoint site path: '/sites/<site-id>/drive/root:/Shared Documents/Attendance/attendance_backup.json'
  itemResourcePath: '',

  // Optional friendly name shown in the UI (team or file label).
  displayName: ''
};
