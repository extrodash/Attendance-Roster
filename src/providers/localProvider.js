function isoDow(dateStr) {
  const d = dayjs(dateStr);
  return d.isoWeekday ? d.isoWeekday() : ((d.day() + 6) % 7) + 1;
}

export function createLocalProvider(db) {
  async function getSettings() {
    return db.dexie.settings.get('app');
  }

  async function saveSettings(settings) {
    if (!settings) return;
    const next = { ...settings, id: settings.id || 'app' };
    await db.dexie.settings.put(next);
    return next;
  }

  async function getEventTypes() {
    return db.listEventTypes();
  }

  async function getRoster() {
    return db.listPeople();
  }

  async function deleteRecord(sessionId, personId) {
    const existing = await db.dexie.records.where({ sessionId, personId }).first();
    if (existing?.id) await db.dexie.records.delete(existing.id);
    return existing;
  }

  async function getFirstSessionDate(eventTypeId) {
    const first = await db.dexie.sessions
      .orderBy('date')
      .filter(s => !eventTypeId || s.eventTypeId === eventTypeId)
      .first();
    return first?.date || null;
  }

  async function hasData() {
    const [peopleCount, recordCount] = await Promise.all([
      db.dexie.people.count(),
      db.dexie.records.count()
    ]);
    return peopleCount > 0 || recordCount > 0;
  }

  function subscribeOnce(fetcher, callback) {
    let active = true;
    Promise.resolve()
      .then(fetcher)
      .then((data) => {
        if (active) callback(data);
      })
      .catch((err) => console.warn('Local subscription error', err));
    return () => { active = false; };
  }

  return {
    mode: 'local',
    async init() {
      await db.seedDefaults();
    },
    getSettings,
    saveSettings,
    getEventTypes,
    saveEventType: (eventType) => db.saveEventType(eventType),
    deleteEventType: (id) => db.deleteEventType(id),
    getRoster,
    addPerson: (name, opts) => db.addPerson(name, opts),
    savePerson: (person) => db.savePerson(person),
    deletePerson: (id) => db.deletePerson(id),
    upsertSession: (date, eventTypeId, notes) => db.upsertSession(date, eventTypeId, notes),
    getRecordsForSession: (sessionId) => db.recordsForSession(sessionId),
    setRecordStatus: (sessionId, personId, status, minutesLate, notes, leaveStatus) =>
      db.setRecordStatus(sessionId, personId, status, minutesLate, notes, leaveStatus),
    deleteRecord,
    clearRecordsForSession: (sessionId) => db.clearRecordsForSession(sessionId),
    recordsForRange: (fromDate, toDate, eventTypeId) => db.recordsForRange(fromDate, toDate, eventTypeId),
    getFirstSessionDate,
    exportAllAsJson: () => db.exportAllAsJson(),
    importAllFromJson: (json) => db.importAllFromJson(json),
    importFromV1IfPresent: () => db.importFromV1IfPresent(),
    clearAll: () => db.dexie.delete(),
    hasData,
    subscribeSettings: (cb) => subscribeOnce(getSettings, cb),
    subscribeRoster: (cb) => subscribeOnce(getRoster, cb),
    subscribeEventTypes: (cb) => subscribeOnce(getEventTypes, cb),
    subscribeSessionRecords: (date, eventTypeId, cb) => {
      const sessionId = `${date}_${eventTypeId}`;
      return subscribeOnce(() => db.recordsForSession(sessionId), cb);
    },
    ensureSessionDate(dateStr) {
      if (!dateStr) return null;
      return { date: dateStr, dow: isoDow(dateStr) };
    }
  };
}
