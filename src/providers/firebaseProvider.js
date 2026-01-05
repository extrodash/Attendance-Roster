import {
  firebaseCurrentUser,
  firebaseDbInstance,
  firebaseOnAuthStateChanged,
  firebaseSignIn,
  firebaseSignOut,
  initFirebase,
  isFirebaseConfigured
} from '../firebase.js';
import { getStoredTeamId, setStoredTeamId } from './providerState.js';
import {
  collection,
  deleteDoc,
  deleteField,
  doc,
  documentId,
  getDoc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  writeBatch
} from 'https://www.gstatic.com/firebasejs/10.12.4/firebase-firestore.js';

const DEFAULT_EVENT_TYPES = [
  { id: 'work', label: 'Office', weight: 1.0 },
  { id: 'meeting', label: 'Morning Meeting', weight: 0.25 },
  { id: 'gospel', label: 'Afternoon Meeting', weight: 0.2 }
];
const DEFAULT_THRESHOLDS = { low: 0.75, mid: 0.89, high: 0.90 };
const DEFAULT_TARDY_MINS = 5;
const ALLOWED_STATUSES = new Set(['present','online','tardy','excused','absent','early_leave','very_early_leave','non_service']);
const SERVICE_DAY_MAP = { M:'Mon', T:'Tue', W:'Wed', R:'Thu', Th:'Thu', F:'Fri', S:'Sat', Su:'Sun', U:'Sun' };
const SERVICE_DAYS = new Set(['Mon','Tue','Wed','Thu','Fri','Sat','Sun']);

function isoDow(dateStr) {
  const d = dayjs(dateStr);
  return d.isoWeekday ? d.isoWeekday() : ((d.day() + 6) % 7) + 1;
}

function normalizeServiceDays(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val.filter(d => SERVICE_DAYS.has(d));
  if (typeof val === 'string') {
    const compact = val.replace(/\s+/g,'').toUpperCase();
    const result = [];
    let i = 0;
    while (i < compact.length) {
      const two = compact.slice(i, i + 2);
      if (two in SERVICE_DAY_MAP) { result.push(SERVICE_DAY_MAP[two]); i += 2; continue; }
      const one = compact[i];
      if (one in SERVICE_DAY_MAP) { result.push(SERVICE_DAY_MAP[one]); i += 1; continue; }
      i += 1;
    }
    return Array.from(new Set(result)).filter(d => SERVICE_DAYS.has(d));
  }
  return [];
}

function normalizeStatus(status) {
  if (ALLOWED_STATUSES.has(status)) return status;
  if (status === 'non-service') return 'non_service';
  if (status === 'unknown') return 'excused';
  if (status == null) return undefined;
  if (typeof status === 'string' && status.trim() === '') return undefined;
  return undefined;
}

function normalizeCollection(raw, key, isSingle) {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') {
    if (isSingle && isSingle(raw)) return [raw];
    return Object.entries(raw).map(([id, value]) => {
      if (value && typeof value === 'object') return { [key]: id, ...value };
      return { [key]: id };
    });
  }
  return [];
}

function normalizeSettings(raw, fallbackName = 'Attendance') {
  const base = raw ? { ...raw } : {};
  const legendThresholds = { ...DEFAULT_THRESHOLDS, ...(base.legendThresholds || {}) };
  const eventTypes = Array.isArray(base.eventTypes) && base.eventTypes.length ? base.eventTypes : DEFAULT_EVENT_TYPES;
  return {
    id: base.id || 'app',
    teamName: base.teamName || fallbackName,
    tardyThresholdMins: Number.isFinite(base.tardyThresholdMins) ? base.tardyThresholdMins : DEFAULT_TARDY_MINS,
    legendThresholds,
    eventTypes,
    ...base
  };
}

function splitSessionId(sessionId) {
  if (typeof sessionId !== 'string') return { dateId: '', sessionKey: sessionId };
  if (sessionId.length >= 11 && sessionId[10] === '_') {
    const dateId = sessionId.slice(0, 10);
    const sessionKey = sessionId.slice(11);
    return { dateId, sessionKey };
  }
  const parts = sessionId.split('_');
  return { dateId: parts[0] || '', sessionKey: parts.slice(1).join('_') || sessionId };
}

function listDates(fromDate, toDate) {
  const dates = [];
  for (let d = dayjs(fromDate); d.isBefore(dayjs(toDate)) || d.isSame(dayjs(toDate), 'day'); d = d.add(1, 'day')) {
    dates.push(d.format('YYYY-MM-DD'));
  }
  return dates;
}

async function batchDeleteDocs(db, refs) {
  let batch = writeBatch(db);
  let count = 0;
  for (const ref of refs) {
    batch.delete(ref);
    count += 1;
    if (count >= 450) {
      await batch.commit();
      batch = writeBatch(db);
      count = 0;
    }
  }
  if (count > 0) await batch.commit();
}

export function createFirebaseProvider() {
  let activeTeamId = getStoredTeamId();
  let activeTeamName = '';
  const pendingMap = new Map();
  const syncListeners = new Set();
  const syncStatus = {
    online: typeof navigator !== 'undefined' ? navigator.onLine : true,
    pendingWrites: false,
    lastSyncedAt: null
  };
  let onlineListenerAttached = false;

  function updateSyncStatus() {
    syncStatus.pendingWrites = Array.from(pendingMap.values()).some(Boolean);
    for (const cb of syncListeners) cb({ ...syncStatus });
  }

  function attachOnlineListeners() {
    if (onlineListenerAttached || typeof window === 'undefined') return;
    onlineListenerAttached = true;
    window.addEventListener('online', () => {
      syncStatus.online = true;
      updateSyncStatus();
    });
    window.addEventListener('offline', () => {
      syncStatus.online = false;
      updateSyncStatus();
    });
  }

  function trackSnapshot(key, snapshot) {
    pendingMap.set(key, snapshot.metadata.hasPendingWrites);
    if (!snapshot.metadata.fromCache) {
      syncStatus.lastSyncedAt = new Date();
    }
    updateSyncStatus();
  }

  function ensureTeamId() {
    if (!activeTeamId) throw new Error('No team selected.');
    return activeTeamId;
  }

  async function ensureFirebaseReady() {
    const init = await initFirebase();
    if (!init.enabled) throw new Error('Firebase is not configured.');
    return init;
  }

  async function ensureSessionDoc(teamId, dateId, sessionKey, extra = {}) {
    const db = await firebaseDbInstance();
    if (!db) return;
    const attendanceRef = doc(db, 'teams', teamId, 'attendance', dateId);
    await setDoc(attendanceRef, { date: dateId, updatedAt: serverTimestamp() }, { merge: true });
    const sessionRef = doc(db, 'teams', teamId, 'attendance', dateId, 'sessions', sessionKey);
    const data = {
      date: dateId,
      dow: isoDow(dateId),
      eventTypeId: sessionKey,
      updatedAt: serverTimestamp(),
      ...extra
    };
    await setDoc(sessionRef, data, { merge: true });
  }

  async function ensureMemberDoc(teamId, user) {
    const db = await firebaseDbInstance();
    if (!db || !user) return;
    const memberRef = doc(db, 'teams', teamId, 'members', user.uid);
    const snap = await getDoc(memberRef);
    if (!snap.exists()) {
      await setDoc(memberRef, {
        role: 'member',
        displayName: user.displayName || user.email || 'Member',
        email: user.email || '',
        joinedAt: serverTimestamp()
      });
    }
  }

  async function getTeamInfo(teamId) {
    const db = await firebaseDbInstance();
    if (!db) return null;
    const teamRef = doc(db, 'teams', teamId);
    const snap = await getDoc(teamRef);
    return snap.exists() ? { id: teamId, ...snap.data() } : null;
  }

  async function clearTeamData(teamId) {
    const db = await firebaseDbInstance();
    if (!db) return;
    const rosterSnap = await getDocs(collection(db, 'teams', teamId, 'roster'));
    await batchDeleteDocs(db, rosterSnap.docs.map(docSnap => docSnap.ref));

    const settingsRef = doc(db, 'teams', teamId, 'settings', 'main');
    await deleteDoc(settingsRef);

    const attendanceSnap = await getDocs(collection(db, 'teams', teamId, 'attendance'));
    for (const dateDoc of attendanceSnap.docs) {
      const sessionsSnap = await getDocs(collection(dateDoc.ref, 'sessions'));
      for (const sessionDoc of sessionsSnap.docs) {
        const recordsSnap = await getDocs(collection(sessionDoc.ref, 'records'));
        await batchDeleteDocs(db, recordsSnap.docs.map(docSnap => docSnap.ref));
        await deleteDoc(sessionDoc.ref);
      }
      await deleteDoc(dateDoc.ref);
    }
  }

  return {
    mode: 'firebase',
    isConfigured: () => isFirebaseConfigured(),
    async init() {
      await ensureFirebaseReady();
      attachOnlineListeners();
    },
    async signIn() {
      return firebaseSignIn();
    },
    async signOut() {
      await firebaseSignOut();
    },
    async onAuthStateChanged(cb) {
      return firebaseOnAuthStateChanged(cb);
    },
    async getCurrentUser() {
      return firebaseCurrentUser();
    },
    getActiveTeamId() {
      return activeTeamId;
    },
    setActiveTeamId(teamId) {
      activeTeamId = teamId || '';
      setStoredTeamId(activeTeamId);
    },
    getActiveTeamName() {
      return activeTeamName;
    },
    async createTeam(name) {
      await ensureFirebaseReady();
      const user = await firebaseCurrentUser();
      if (!user) throw new Error('Sign in to create a team.');
      const db = await firebaseDbInstance();
      const teamRef = doc(collection(db, 'teams'));
      const teamName = name?.trim() || 'Attendance';
      await setDoc(teamRef, {
        name: teamName,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        createdBy: user.uid
      });
      await setDoc(doc(db, 'teams', teamRef.id, 'members', user.uid), {
        role: 'lead',
        displayName: user.displayName || user.email || 'Lead',
        email: user.email || '',
        joinedAt: serverTimestamp()
      });
      const settings = normalizeSettings({ teamName, eventTypes: DEFAULT_EVENT_TYPES });
      await setDoc(doc(db, 'teams', teamRef.id, 'settings', 'main'), {
        ...settings,
        updatedAt: serverTimestamp(),
        updatedBy: user.uid
      });
      activeTeamId = teamRef.id;
      activeTeamName = teamName;
      setStoredTeamId(activeTeamId);
      return { id: teamRef.id, name: teamName };
    },
    async joinTeam(teamId) {
      await ensureFirebaseReady();
      const user = await firebaseCurrentUser();
      if (!user) throw new Error('Sign in to join a team.');
      const teamInfo = await getTeamInfo(teamId);
      if (!teamInfo) throw new Error('Team not found.');
      await ensureMemberDoc(teamId, user);
      activeTeamId = teamId;
      activeTeamName = teamInfo.name || '';
      setStoredTeamId(activeTeamId);
      return { id: teamId, name: activeTeamName };
    },
    async refreshTeamInfo() {
      const teamId = ensureTeamId();
      const info = await getTeamInfo(teamId);
      activeTeamName = info?.name || '';
      return info;
    },
    subscribeSyncStatus(cb) {
      attachOnlineListeners();
      syncListeners.add(cb);
      cb({ ...syncStatus });
      return () => {
        syncListeners.delete(cb);
      };
    },
    async getSettings() {
      const db = await firebaseDbInstance();
      const teamId = ensureTeamId();
      const settingsRef = doc(db, 'teams', teamId, 'settings', 'main');
      const snap = await getDoc(settingsRef);
      const normalized = normalizeSettings(snap.exists() ? snap.data() : null, activeTeamName);
      if (normalized.teamName) activeTeamName = normalized.teamName;
      return normalized;
    },
    async saveSettings(settings) {
      const db = await firebaseDbInstance();
      const teamId = ensureTeamId();
      const user = await firebaseCurrentUser();
      const current = await this.getSettings();
      const merged = { ...current, ...settings };
      if (!Array.isArray(merged.eventTypes) || merged.eventTypes.length === 0) {
        merged.eventTypes = current.eventTypes || DEFAULT_EVENT_TYPES;
      }
      const payload = normalizeSettings(merged, activeTeamName);
      await setDoc(doc(db, 'teams', teamId, 'settings', 'main'), {
        ...payload,
        updatedAt: serverTimestamp(),
        updatedBy: user?.uid || null
      }, { merge: true });
      if (payload.teamName) {
        await updateDoc(doc(db, 'teams', teamId), { name: payload.teamName, updatedAt: serverTimestamp() });
        activeTeamName = payload.teamName;
      }
      return payload;
    },
    async getEventTypes() {
      const settings = await this.getSettings();
      return settings.eventTypes || DEFAULT_EVENT_TYPES;
    },
    async saveEventType(eventType) {
      const settings = await this.getSettings();
      const existing = Array.isArray(settings.eventTypes) ? settings.eventTypes : [];
      const idx = existing.findIndex(et => et.id === eventType.id);
      if (idx >= 0) existing[idx] = { ...existing[idx], ...eventType };
      else existing.push(eventType);
      return this.saveSettings({ ...settings, eventTypes: existing });
    },
    async deleteEventType(id) {
      const settings = await this.getSettings();
      const existing = Array.isArray(settings.eventTypes) ? settings.eventTypes : [];
      return this.saveSettings({ ...settings, eventTypes: existing.filter(et => et.id !== id) });
    },
    subscribeSettings(cb) {
      const teamId = ensureTeamId();
      return firebaseDbInstance().then((db) => onSnapshot(
        doc(db, 'teams', teamId, 'settings', 'main'),
        { includeMetadataChanges: true },
        (snapshot) => {
          trackSnapshot('settings', snapshot);
          const normalized = normalizeSettings(snapshot.exists() ? snapshot.data() : null, activeTeamName);
          if (normalized.teamName) activeTeamName = normalized.teamName;
          cb(normalized);
        },
        (err) => console.warn('Settings listener error', err)
      ));
    },
    subscribeEventTypes(cb) {
      return this.subscribeSettings(settings => cb(settings.eventTypes || DEFAULT_EVENT_TYPES));
    },
    async getRoster() {
      const db = await firebaseDbInstance();
      const teamId = ensureTeamId();
      const rosterSnap = await getDocs(query(collection(db, 'teams', teamId, 'roster'), orderBy('displayName')));
      return rosterSnap.docs.map(docSnap => {
        const data = docSnap.data() || {};
        return {
          id: docSnap.id,
          ...data,
          tags: Array.isArray(data.tags) ? data.tags : [],
          serviceDays: normalizeServiceDays(data.serviceDays)
        };
      });
    },
    subscribeRoster(cb) {
      const teamId = ensureTeamId();
      return firebaseDbInstance().then((db) => onSnapshot(
        query(collection(db, 'teams', teamId, 'roster'), orderBy('displayName')),
        { includeMetadataChanges: true },
        (snapshot) => {
          trackSnapshot('roster', snapshot);
          cb(snapshot.docs.map(docSnap => {
            const data = docSnap.data() || {};
            return {
              id: docSnap.id,
              ...data,
              tags: Array.isArray(data.tags) ? data.tags : [],
              serviceDays: normalizeServiceDays(data.serviceDays)
            };
          }));
        },
        (err) => console.warn('Roster listener error', err)
      ));
    },
    async addPerson(displayName, { active = true, tags = [], serviceDays = [] } = {}) {
      const db = await firebaseDbInstance();
      const teamId = ensureTeamId();
      const user = await firebaseCurrentUser();
      const personRef = doc(collection(db, 'teams', teamId, 'roster'));
      const payload = {
        displayName,
        active,
        tags,
        serviceDays,
        updatedAt: serverTimestamp(),
        updatedBy: user?.uid || null
      };
      await setDoc(personRef, payload);
      return personRef.id;
    },
    async savePerson(person) {
      const db = await firebaseDbInstance();
      const teamId = ensureTeamId();
      const user = await firebaseCurrentUser();
      const payload = {
        displayName: person.displayName,
        active: person.active !== false,
        tags: person.tags || [],
        serviceDays: person.serviceDays || [],
        updatedAt: serverTimestamp(),
        updatedBy: user?.uid || null
      };
      await setDoc(doc(db, 'teams', teamId, 'roster', person.id), payload, { merge: true });
      return person.id;
    },
    async deletePerson(id) {
      const db = await firebaseDbInstance();
      const teamId = ensureTeamId();
      await deleteDoc(doc(db, 'teams', teamId, 'roster', id));
      const attendanceSnap = await getDocs(collection(db, 'teams', teamId, 'attendance'));
      for (const dateDoc of attendanceSnap.docs) {
        const sessionsSnap = await getDocs(collection(dateDoc.ref, 'sessions'));
        for (const sessionDoc of sessionsSnap.docs) {
          const recordRef = doc(sessionDoc.ref, 'records', id);
          await deleteDoc(recordRef);
        }
      }
    },
    async upsertSession(date, eventTypeId, notes = '') {
      const teamId = ensureTeamId();
      await ensureSessionDoc(teamId, date, eventTypeId, { notes });
      return `${date}_${eventTypeId}`;
    },
    async getRecordsForSession(sessionId) {
      const db = await firebaseDbInstance();
      const teamId = ensureTeamId();
      const { dateId, sessionKey } = splitSessionId(sessionId);
      const recordsSnap = await getDocs(collection(db, 'teams', teamId, 'attendance', dateId, 'sessions', sessionKey, 'records'));
      return recordsSnap.docs.map(docSnap => ({
        id: docSnap.id,
        sessionId,
        personId: docSnap.id,
        ...docSnap.data()
      }));
    },
    subscribeSessionRecords(dateId, eventTypeId, cb) {
      const teamId = ensureTeamId();
      const sessionId = `${dateId}_${eventTypeId}`;
      return firebaseDbInstance().then((db) => onSnapshot(
        collection(db, 'teams', teamId, 'attendance', dateId, 'sessions', eventTypeId, 'records'),
        { includeMetadataChanges: true },
        (snapshot) => {
          trackSnapshot(`records:${sessionId}`, snapshot);
          cb(snapshot.docs.map(docSnap => ({
            id: docSnap.id,
            sessionId,
            personId: docSnap.id,
            ...docSnap.data()
          })));
        },
        (err) => console.warn('Session listener error', err)
      ));
    },
    async setRecordStatus(sessionId, personId, status, minutesLate = undefined, notes = undefined, leaveStatus = undefined) {
      const db = await firebaseDbInstance();
      const teamId = ensureTeamId();
      const { dateId, sessionKey } = splitSessionId(sessionId);
      await ensureSessionDoc(teamId, dateId, sessionKey);
      const user = await firebaseCurrentUser();
      const payload = {
        status: status ?? null,
        updatedAt: serverTimestamp(),
        updatedBy: user?.uid || null,
        personId
      };
      if (minutesLate !== undefined) payload.minutesLate = minutesLate;
      else payload.minutesLate = deleteField();
      if (notes !== undefined) payload.notes = notes;
      else payload.notes = deleteField();
      if (leaveStatus !== undefined) {
        if (leaveStatus) payload.leaveStatus = leaveStatus;
        else payload.leaveStatus = deleteField();
      }
      await setDoc(
        doc(db, 'teams', teamId, 'attendance', dateId, 'sessions', sessionKey, 'records', personId),
        payload,
        { merge: true }
      );
      return { id: personId, sessionId, personId, status, minutesLate, notes, leaveStatus };
    },
    async deleteRecord(sessionId, personId) {
      const db = await firebaseDbInstance();
      const teamId = ensureTeamId();
      const { dateId, sessionKey } = splitSessionId(sessionId);
      const recordRef = doc(db, 'teams', teamId, 'attendance', dateId, 'sessions', sessionKey, 'records', personId);
      await deleteDoc(recordRef);
      return { id: personId, sessionId, personId };
    },
    async clearRecordsForSession(sessionId) {
      const db = await firebaseDbInstance();
      const teamId = ensureTeamId();
      const { dateId, sessionKey } = splitSessionId(sessionId);
      const recordsSnap = await getDocs(collection(db, 'teams', teamId, 'attendance', dateId, 'sessions', sessionKey, 'records'));
      await batchDeleteDocs(db, recordsSnap.docs.map(docSnap => docSnap.ref));
    },
    async recordsForRange(fromDate, toDate, eventTypeId) {
      const db = await firebaseDbInstance();
      const teamId = ensureTeamId();
      const dates = listDates(fromDate, toDate);
      const sessions = [];
      const records = [];
      for (const dateId of dates) {
        const sessionsSnap = await getDocs(collection(db, 'teams', teamId, 'attendance', dateId, 'sessions'));
        for (const sessionDoc of sessionsSnap.docs) {
          const sessionData = sessionDoc.data() || {};
          const sessionKey = sessionData.eventTypeId || sessionDoc.id;
          if (eventTypeId && sessionKey !== eventTypeId) continue;
          const sessionId = `${dateId}_${sessionKey}`;
          sessions.push({
            id: sessionId,
            date: dateId,
            dow: sessionData.dow || isoDow(dateId),
            eventTypeId: sessionKey,
            notes: sessionData.notes || ''
          });
          const recordsSnap = await getDocs(collection(sessionDoc.ref, 'records'));
          for (const recordDoc of recordsSnap.docs) {
            const recData = recordDoc.data() || {};
            records.push({
              id: recordDoc.id,
              sessionId,
              personId: recData.personId || recordDoc.id,
              status: recData.status ?? null,
              minutesLate: recData.minutesLate,
              notes: recData.notes,
              leaveStatus: recData.leaveStatus
            });
          }
        }
      }
      return { sessions, records };
    },
    async getFirstSessionDate(eventTypeId) {
      const db = await firebaseDbInstance();
      const teamId = ensureTeamId();
      const attendanceSnap = await getDocs(query(
        collection(db, 'teams', teamId, 'attendance'),
        orderBy(documentId())
      ));
      for (const dateDoc of attendanceSnap.docs) {
        if (!eventTypeId) return dateDoc.id;
        const sessionRef = doc(db, 'teams', teamId, 'attendance', dateDoc.id, 'sessions', eventTypeId);
        const sessionSnap = await getDoc(sessionRef);
        if (sessionSnap.exists()) return dateDoc.id;
      }
      return null;
    },
    async exportAllAsJson() {
      const db = await firebaseDbInstance();
      const teamId = ensureTeamId();
      const settings = await this.getSettings();
      const rosterSnap = await getDocs(collection(db, 'teams', teamId, 'roster'));
      const people = rosterSnap.docs.map(docSnap => ({ id: docSnap.id, ...docSnap.data() }));
      const eventTypes = settings.eventTypes || DEFAULT_EVENT_TYPES;
      const sessions = [];
      const records = [];
      const attendanceSnap = await getDocs(collection(db, 'teams', teamId, 'attendance'));
      for (const dateDoc of attendanceSnap.docs) {
        const dateId = dateDoc.id;
        const sessionsSnap = await getDocs(collection(dateDoc.ref, 'sessions'));
        for (const sessionDoc of sessionsSnap.docs) {
          const sessionData = sessionDoc.data() || {};
          const sessionKey = sessionData.eventTypeId || sessionDoc.id;
          const sessionId = `${dateId}_${sessionKey}`;
          sessions.push({
            id: sessionId,
            date: dateId,
            dow: sessionData.dow || isoDow(dateId),
            eventTypeId: sessionKey,
            notes: sessionData.notes || ''
          });
          const recordsSnap = await getDocs(collection(sessionDoc.ref, 'records'));
          for (const recordDoc of recordsSnap.docs) {
            const recData = recordDoc.data() || {};
            records.push({
              id: recordDoc.id,
              sessionId,
              personId: recData.personId || recordDoc.id,
              status: recData.status ?? null,
              minutesLate: recData.minutesLate,
              notes: recData.notes,
              leaveStatus: recData.leaveStatus
            });
          }
        }
      }
      return {
        people,
        eventTypes,
        sessions,
        records,
        settings: [{ ...settings }]
      };
    },
    async importAllFromJson(json) {
      json = json || {};
      const db = await firebaseDbInstance();
      const teamId = ensureTeamId();
      const settingsList = normalizeCollection(json.settings, 'id', (val) => 'teamName' in val || 'legendThresholds' in val || 'tardyThresholdMins' in val || 'eventTypes' in val);
      const settingsRaw = settingsList[0] || {};
      const jsonEventTypes = normalizeCollection(json.eventTypes, 'id', (val) => 'label' in val || 'weight' in val);
      const settingsEventTypes = normalizeCollection(settingsRaw.eventTypes, 'id', (val) => 'label' in val || 'weight' in val);
      const normalizedEventTypes = jsonEventTypes.length ? jsonEventTypes : (settingsEventTypes.length ? settingsEventTypes : settingsRaw.eventTypes);
      const normalizedSettings = normalizeSettings({
        ...settingsRaw,
        eventTypes: normalizedEventTypes
      }, activeTeamName);
      await clearTeamData(teamId);
      await setDoc(doc(db, 'teams', teamId, 'settings', 'main'), {
        ...normalizedSettings,
        updatedAt: serverTimestamp(),
        updatedBy: (await firebaseCurrentUser())?.uid || null
      });
      if (normalizedSettings.teamName) {
        await updateDoc(doc(db, 'teams', teamId), { name: normalizedSettings.teamName, updatedAt: serverTimestamp() });
        activeTeamName = normalizedSettings.teamName;
      }
      const people = normalizeCollection(json.people, 'id', (val) => 'displayName' in val || 'serviceDays' in val)
        .map(person => ({
          ...person,
          displayName: person.displayName || person.fullName || person.name || '',
          tags: Array.isArray(person.tags) ? person.tags : [],
          serviceDays: normalizeServiceDays(person.serviceDays)
        }))
        .filter(person => person.id && person.displayName);
      for (const person of people) {
        await setDoc(doc(db, 'teams', teamId, 'roster', person.id), {
          displayName: person.displayName,
          active: person.active !== false,
          tags: person.tags || [],
          serviceDays: person.serviceDays || [],
          updatedAt: serverTimestamp()
        });
      }
      const sessions = normalizeCollection(json.sessions, 'id', (val) => 'date' in val || 'eventTypeId' in val)
        .map(session => {
          const split = splitSessionId(session.id);
          const dateId = session.date || split.dateId;
          const eventTypeId = session.eventTypeId || split.sessionKey;
          const dow = dateId ? isoDow(dateId) : session.dow;
          return { ...session, date: dateId, eventTypeId, dow };
        });
      for (const session of sessions) {
        const dateId = session.date || splitSessionId(session.id).dateId;
        const eventTypeId = session.eventTypeId || splitSessionId(session.id).sessionKey;
        if (!dateId || !eventTypeId) continue;
        await ensureSessionDoc(teamId, dateId, eventTypeId, { notes: session.notes || '' });
      }
      const records = normalizeCollection(json.records, 'id', (val) => 'personId' in val || 'sessionId' in val || 'status' in val)
        .map(record => ({ ...record, status: normalizeStatus(record.status) }));
      for (const record of records) {
        const { dateId, sessionKey } = splitSessionId(record.sessionId || '');
        if (!dateId || !sessionKey || !record.personId) continue;
        await setDoc(
          doc(db, 'teams', teamId, 'attendance', dateId, 'sessions', sessionKey, 'records', record.personId),
          {
            status: record.status ?? null,
            minutesLate: record.minutesLate ?? null,
            notes: record.notes ?? '',
            leaveStatus: record.leaveStatus ?? null,
            personId: record.personId,
            updatedAt: serverTimestamp()
          },
          { merge: true }
        );
      }
    },
    async hasTeamData() {
      const db = await firebaseDbInstance();
      const teamId = ensureTeamId();
      const rosterSnap = await getDocs(query(collection(db, 'teams', teamId, 'roster'), orderBy('displayName')));
      if (rosterSnap.size > 0) return true;
      const settingsSnap = await getDoc(doc(db, 'teams', teamId, 'settings', 'main'));
      if (settingsSnap.exists()) return true;
      const attendanceSnap = await getDocs(collection(db, 'teams', teamId, 'attendance'));
      return attendanceSnap.size > 0;
    }
  };
}
