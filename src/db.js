// Attendance v2 - data layer (Dexie)

// dayjs setup
if (typeof dayjs !== 'undefined') {
  try {
    if (window.dayjs_plugin_utc) dayjs.extend(window.dayjs_plugin_utc);
    if (window.dayjs_plugin_timezone) dayjs.extend(window.dayjs_plugin_timezone);
  } catch (e) {
    // Plugins may not be present; continue without them
  }
}

// DB
const DB_NAME = 'attendance_v2';
// eslint-disable-next-line no-undef
const dexie = new Dexie(DB_NAME);
dexie.version(1).stores({
  people: 'id, displayName, active, *tags',
  eventTypes: 'id, label, weight',
  sessions: 'id, date, dow, eventTypeId',
  records: 'id, sessionId, personId, status',
  settings: 'id'
});

function uid(prefix = '') {
  if (crypto && 'randomUUID' in crypto) return prefix + crypto.randomUUID();
  return prefix + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

const DEFAULT_EVENT_TYPES = [
  { id: 'work', label: 'Office', weight: 1.0 },
  { id: 'meeting', label: 'Morning Meeting', weight: 0.25 },
  { id: 'gospel', label: 'Afternoon Meeting', weight: 0.2 }
];
const DEFAULT_THRESHOLDS = { low: 0.75, mid: 0.89, high: 0.90 };
const DEFAULT_TARDY_MINS = 5;

function isoDow(dateStr) {
  const d = dayjs(dateStr);
  return d.isoWeekday ? d.isoWeekday() : ((d.day() + 6) % 7) + 1; // 1..7 Mon..Sun
}

async function seedDefaults() {
  const hasSettings = await dexie.settings.get('app');
  if (!hasSettings) {
    await dexie.settings.put({ id: 'app', teamName: 'Attendance', tardyThresholdMins: DEFAULT_TARDY_MINS, legendThresholds: DEFAULT_THRESHOLDS });
  }
  const existingTypes = await dexie.eventTypes.toArray();
  if (!existingTypes || existingTypes.length === 0) {
    await dexie.eventTypes.bulkPut(DEFAULT_EVENT_TYPES);
  }
  // Seed sample people and records on first run
  const peopleCount = await dexie.people.count();
  if (peopleCount === 0) {
    const sample = ['Alice','Bob','Carol','Dave','Eve'].map((n) => ({ id: uid('p_'), displayName: n, active: true, tags: [], serviceDays: [] }));
    await dexie.people.bulkAdd(sample);
    const today = dayjs().format('YYYY-MM-DD');
    const office = await dexie.eventTypes.where('id').equals('work').first();
    const sessionId = `${today}_${office?.id || 'work'}`;
    await dexie.sessions.put({ id: sessionId, date: today, dow: isoDow(today), eventTypeId: office?.id || 'work' });
    const recs = sample.map((p, i) => ({ id: uid('r_'), sessionId, personId: p.id, status: i % 4 === 0 ? 'tardy' : 'present' }));
    await dexie.records.bulkAdd(recs);
  }
}

// People
async function listPeople() { return dexie.people.orderBy('displayName').toArray(); }
async function addPerson(displayName, { active = true, tags = [], serviceDays = [] } = {}) {
  const id = uid('p_'); await dexie.people.add({ id, displayName, active, tags, serviceDays }); return id;
}
async function savePerson(person) { await dexie.people.put(person); }
async function deletePerson(id) {
  await dexie.transaction('rw', dexie.people, dexie.records, async () => {
    await dexie.records.where('personId').equals(id).delete();
    await dexie.people.delete(id);
  });
}

// Event Types
async function listEventTypes() { return dexie.eventTypes.toArray(); }
async function saveEventType(et) { await dexie.eventTypes.put(et); }
async function deleteEventType(id) { await dexie.eventTypes.delete(id); }

// Sessions / Records
async function upsertSession(date, eventTypeId, notes = '') {
  const id = `${date}_${eventTypeId}`; const session = { id, date, dow: isoDow(date), eventTypeId, notes }; await dexie.sessions.put(session); return id;
}
async function recordsForSession(sessionId) { return dexie.records.where('sessionId').equals(sessionId).toArray(); }
async function setRecordStatus(sessionId, personId, status, minutesLate = undefined, notes = undefined, leaveStatus = undefined) {
  const existing = await dexie.records.where({ sessionId, personId }).first();
  if (existing) {
    existing.status = status;
    if (minutesLate !== undefined) existing.minutesLate = minutesLate; else delete existing.minutesLate;
    if (notes !== undefined) existing.notes = notes; else delete existing.notes;
    if (leaveStatus !== undefined) {
      if (leaveStatus) existing.leaveStatus = leaveStatus;
      else delete existing.leaveStatus;
    }
    await dexie.records.put(existing);
    return existing.id;
  }
  const id = uid('r_');
  const record = { id, sessionId, personId, status };
  if (minutesLate !== undefined) record.minutesLate = minutesLate;
  if (notes !== undefined) record.notes = notes;
  if (leaveStatus !== undefined && leaveStatus) record.leaveStatus = leaveStatus;
  await dexie.records.add(record);
  return id;
}
async function clearRecordsForSession(sessionId) { await dexie.records.where('sessionId').equals(sessionId).delete(); }

async function recordsForRange(fromDate, toDate, eventTypeId) {
  const sessions = await dexie.sessions
    .where('date').between(fromDate, toDate, true, true)
    .and(s => !eventTypeId || s.eventTypeId === eventTypeId)
    .toArray();
  const sessionIds = new Set(sessions.map(s => s.id));
  const records = await dexie.records.where('sessionId').anyOf([...sessionIds]).toArray();
  return { sessions, records };
}

// Analytics helpers
function aggregateCounts(records) {
  const counts = { present: 0, online: 0, excused: 0, tardy: 0, absent: 0, early_leave: 0, very_early_leave: 0, non_service: 0 };
  for (const r of records) {
    if (!r || !r.status) continue; // exclude blanks entirely
    counts[r.status] = (counts[r.status] || 0) + 1;
    if (r.leaveStatus && r.leaveStatus !== r.status) {
      counts[r.leaveStatus] = (counts[r.leaveStatus] || 0) + 1;
    }
  }
  return counts;
}
async function analyticsByDOW(fromDate, toDate, eventTypeId) {
  const { sessions, records } = await recordsForRange(fromDate, toDate, eventTypeId);
  const grouped = { 1:{},2:{},3:{},4:{},5:{},6:{},7:{} };
  for (const s of sessions) {
    const recs = records.filter(r => r.sessionId === s.id);
    grouped[s.dow] = aggregateCounts(recs);
  }
  return grouped;
}
async function analyticsTrends(fromDate, toDate, eventTypeId) {
  const { sessions, records } = await recordsForRange(fromDate, toDate, eventTypeId);
  const byDate = new Map();
  for (const s of sessions) {
    const recs = records.filter(r => r.sessionId === s.id);
    byDate.set(s.date, aggregateCounts(recs));
  }
  const dates = [...byDate.keys()].sort();
  const series = { dates,
    present: dates.map(d => byDate.get(d)?.present || 0),
    excused: dates.map(d => byDate.get(d)?.excused || 0),
    tardy: dates.map(d => byDate.get(d)?.tardy || 0),
    absent: dates.map(d => byDate.get(d)?.absent || 0)
  };
  return series;
}

// Backup/restore & v1 importer (best-effort)
async function exportAllAsJson() {
  const [people, eventTypes, sessions, records, settings] = await Promise.all([
    dexie.people.toArray(), dexie.eventTypes.toArray(), dexie.sessions.toArray(), dexie.records.toArray(), dexie.settings.toArray()
  ]);
  return { people, eventTypes, sessions, records, settings };
}
async function importAllFromJson(json) {
  json = json || {};
  const allowedStatuses = new Set(['present','online','tardy','excused','absent','early_leave','very_early_leave','non_service']);
  const dayMap = { M:'Mon', T:'Tue', W:'Wed', R:'Thu', Th:'Thu', F:'Fri', S:'Sat', Su:'Sun', U:'Sun' };
  const allowedDays = new Set(['Mon','Tue','Wed','Thu','Fri','Sat','Sun']);
  const hasProp = (obj, key) => Object.prototype.hasOwnProperty.call(obj || {}, key);

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

  function normalizeServiceDays(val) {
    if (!val) return [];
    if (Array.isArray(val)) return val.filter(d => allowedDays.has(d));
    if (typeof val === 'string') {
      const compact = val.replace(/\s+/g,'').toUpperCase();
      // Support patterns like "MWF", "TWR", "MTWThF"
      const result = [];
      // Try two-letter tokens first for Thu (TH) and Sun (SU)
      let i = 0; while (i < compact.length) {
        const two = compact.slice(i, i+2);
        if (two in dayMap) { result.push(dayMap[two]); i += 2; continue; }
        const one = compact[i]; if (one in dayMap) { result.push(dayMap[one]); i += 1; continue; }
        i += 1;
      }
      // De-dup and filter to allowed
      return Array.from(new Set(result)).filter(d => allowedDays.has(d));
    }
    return [];
  }

  function normalizeStatus(s) {
    // Preserve blanks as undefined; only map known values
    if (allowedStatuses.has(s)) return s;
    if (s === 'non-service') return 'non_service';
    if (s === 'unknown') return 'excused';
    // Treat null/empty/whitespace as missing
    if (s == null) return undefined;
    if (typeof s === 'string' && s.trim() === '') return undefined;
    // Unrecognized strings should not auto-assume 'present'
    return undefined;
  }

  const rawPeople = normalizeCollection(json.people, 'id', (val) => 'displayName' in val || 'serviceDays' in val);
  const rawEventTypes = normalizeCollection(json.eventTypes, 'id', (val) => 'label' in val || 'weight' in val);
  const rawSessions = normalizeCollection(json.sessions, 'id', (val) => 'date' in val || 'eventTypeId' in val);
  const rawRecords = normalizeCollection(json.records, 'id', (val) => 'personId' in val || 'sessionId' in val || 'status' in val);
  const rawSettings = normalizeCollection(json.settings, 'id', (val) => 'teamName' in val || 'legendThresholds' in val || 'tardyThresholdMins' in val || 'eventTypes' in val);
  if (rawSettings.length === 1 && !rawSettings[0].id) rawSettings[0].id = 'app';

  const people = rawPeople.map(p => ({
    ...p,
    serviceDays: normalizeServiceDays(p.serviceDays)
  }));

  const sessions = rawSessions.map(s => ({
    ...s,
    // Ensure dow is correct for the given date
    dow: (() => { try { const d = dayjs(s.date); return d.isValid() ? ((d.day()+6)%7)+1 : s.dow; } catch { return s.dow; } })()
  }));

  const records = rawRecords.map(r => ({
    ...r,
    status: normalizeStatus(r.status)
  }));

  await dexie.transaction('rw', dexie.people, dexie.eventTypes, dexie.sessions, dexie.records, dexie.settings, async () => {
    if (hasProp(json, 'people')) { await dexie.people.clear(); await dexie.people.bulkAdd(people); }
    if (hasProp(json, 'eventTypes')) { await dexie.eventTypes.clear(); await dexie.eventTypes.bulkAdd(rawEventTypes); }
    if (hasProp(json, 'sessions')) { await dexie.sessions.clear(); await dexie.sessions.bulkAdd(sessions); }
    if (hasProp(json, 'records')) { await dexie.records.clear(); await dexie.records.bulkAdd(records); }
    if (hasProp(json, 'settings')) { await dexie.settings.clear(); await dexie.settings.bulkAdd(rawSettings); }
  });
}

async function importFromV1IfPresent() {
  try {
    // eslint-disable-next-line no-undef
    const v1 = new Dexie('attendance_db');
    v1.version(1).stores({ people: 'id, displayName, active, *tags', eventTypes: 'id, label, weight', sessions: 'id, date, dow, eventTypeId', records: 'id, sessionId, personId, status', settings: 'id' });
    const [people, eventTypes, sessions, records, settings] = await Promise.all([
      v1.people.toArray(), v1.eventTypes.toArray(), v1.sessions.toArray(), v1.records.toArray(), v1.settings.toArray()
    ]);
    if ((people?.length || 0) === 0 && (records?.length || 0) === 0) return { imported: false, reason: 'No v1 data' };
    await importAllFromJson({ people, eventTypes, sessions, records, settings });
    return { imported: true, people: people.length, records: records.length };
  } catch (e) {
    return { imported: false, error: String(e) };
  }
}

export const DB = {
  dexie,
  seedDefaults,
  listPeople, addPerson, savePerson, deletePerson,
  listEventTypes, saveEventType, deleteEventType,
  upsertSession, recordsForSession, setRecordStatus, clearRecordsForSession, recordsForRange,
  analyticsByDOW, analyticsTrends,
  exportAllAsJson, importAllFromJson, importFromV1IfPresent,
};
