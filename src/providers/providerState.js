const SYNC_MODE_KEY = 'attendance_sync_mode';
const TEAM_ID_KEY = 'attendance_team_id';

export function getStoredSyncMode() {
  try {
    return localStorage.getItem(SYNC_MODE_KEY) || 'local';
  } catch (err) {
    return 'local';
  }
}

export function setStoredSyncMode(mode) {
  try {
    if (!mode) localStorage.removeItem(SYNC_MODE_KEY);
    else localStorage.setItem(SYNC_MODE_KEY, mode);
  } catch (err) {
    // ignore storage errors
  }
}

export function getStoredTeamId() {
  try {
    return localStorage.getItem(TEAM_ID_KEY) || '';
  } catch (err) {
    return '';
  }
}

export function setStoredTeamId(teamId) {
  try {
    if (!teamId) localStorage.removeItem(TEAM_ID_KEY);
    else localStorage.setItem(TEAM_ID_KEY, teamId);
  } catch (err) {
    // ignore storage errors
  }
}
