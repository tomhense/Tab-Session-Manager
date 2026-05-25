import browser from "webextension-polyfill";
import pako from "pako";
import log from "loglevel";

const logDir = "background/sessions";
const syncChunkPrefix = "tabSessionManagerSessionsChunk_";
const syncChunkSize = 6000;
const syncPayloadPrefix = "TSM1:";

let DB;
let syncState = {
  deletedAllAt: 0,
  deletedSessions: {}
};
let syncTimer;
let isSyncing = false;
let isSyncSuspended = false;

const openDatabase = () =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open("sessions", 1);

    request.onupgradeneeded = () => {
      const db = request.result;
      const store = db.createObjectStore("sessions", {
        keyPath: "id"
      });

      store.createIndex("name", "name");
      store.createIndex("date", "date");
      store.createIndex("tag", "tag");
      store.createIndex("tabsNumber", "tabsNumber");
      store.createIndex("windowsNumber", "windowsNumber");
      store.createIndex("sessionStartTime", "sessionStartTime");
    };

    request.onsuccess = () => {
      DB = request.result;
      resolve();
    };
    request.onerror = e => {
      reject(e);
    };
  });

const readAllLocalSessions = (needKeys = null) => {
  const db = DB;
  const transaction = db.transaction("sessions", "readonly");
  const store = transaction.objectStore("sessions");
  const request = store.openCursor();

  let sessions = [];
  return new Promise((resolve, reject) => {
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) {
        let session = {};
        if (needKeys == null) {
          session = cursor.value;
        } else {
          for (const key of needKeys) {
            session[key] = cursor.value[key];
          }
        }
        sessions.push(session);
        cursor.continue();
      } else {
        resolve(sessions);
      }
    };
    request.onerror = () => {
      reject(request);
    };
  });
};

const readLocalSession = id => {
  const db = DB;
  const transaction = db.transaction("sessions", "readonly");
  const store = transaction.objectStore("sessions");
  const request = store.get(id);

  return new Promise((resolve, reject) => {
    request.onsuccess = () => {
      if (request.result) resolve(request.result);
      else reject(request);
    };
    request.onerror = () => {
      reject(request);
    };
  });
};

const putLocalSession = session => {
  const db = DB;
  const transaction = db.transaction("sessions", "readwrite");
  const store = transaction.objectStore("sessions");
  const request = store.put(session);

  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve();
    request.onerror = e => reject(e.target);
  });
};

const deleteLocalSession = id => {
  const db = DB;
  const transaction = db.transaction("sessions", "readwrite");
  const store = transaction.objectStore("sessions");
  const request = store.delete(id);

  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = e => reject(e.target);
  });
};

const deleteLocalDatabase = async () => {
  if (DB) DB.close();
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase("sessions");
    request.onsuccess = () => resolve();
    request.onerror = e => reject(e);
  });
  await openDatabase();
};

const shouldSyncSession = session => {
  return !!session && !session.tag.includes("temp");
};

const summarizeSession = session => {
  const windows = Object.keys(session.windows || {}).length;
  const tabs = Object.values(session.windows || {}).reduce((count, windowTabs) => {
    return count + Object.keys(windowTabs || {}).length;
  }, 0);
  return {
    id: session.id,
    name: session.name,
    windows,
    tabs,
    lastEditedTime: session.lastEditedTime,
    tags: session.tag
  };
};

const calcJsonSize = value => new Blob([JSON.stringify(value)], { type: "application/json" }).size;

const calcTextSize = value => new Blob([value], { type: "text/plain" }).size;

const isDeletedBySyncState = session => {
  const deletedAt = Math.max(
    syncState.deletedAllAt || 0,
    syncState.deletedSessions?.[session.id] || 0
  );
  return deletedAt > session.lastEditedTime;
};

const splitIntoChunks = value => {
  const chunks = [];
  for (let index = 0; index < value.length; index += syncChunkSize) {
    chunks.push(value.slice(index, index + syncChunkSize));
  }
  return chunks;
};

const encodeBase64 = bytes => {
  let binary = "";
  for (let index = 0; index < bytes.length; index++) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary);
};

const decodeBase64 = value => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

const encodeSyncPayload = state => {
  const json = JSON.stringify(state);
  const compressed = pako.deflate(json);
  const payload = syncPayloadPrefix + encodeBase64(compressed);
  log.info(logDir, "encodeSyncPayload()", {
    stateSize: calcJsonSize(state),
    jsonSize: calcTextSize(json),
    compressedSize: compressed.byteLength,
    payloadSize: calcTextSize(payload),
    sessionCount: state.sessions?.length || 0,
    deletedSessionCount: Object.keys(state.deletedSessions || {}).length,
    deletedAllAt: state.deletedAllAt || 0
  });
  return payload;
};

const decodeSyncPayload = payload => {
  if (payload.startsWith(syncPayloadPrefix)) {
    const compressed = decodeBase64(payload.slice(syncPayloadPrefix.length));
    return JSON.parse(pako.inflate(compressed, { to: "string" }));
  }
  return JSON.parse(payload);
};

const getSyncChunkKeys = storage =>
  Object.keys(storage)
    .filter(key => key.startsWith(syncChunkPrefix))
    .sort((a, b) => Number(a.slice(syncChunkPrefix.length)) - Number(b.slice(syncChunkPrefix.length)));

const readSyncState = async () => {
  const storage = await browser.storage.sync.get(null);
  const chunkKeys = getSyncChunkKeys(storage);
  if (chunkKeys.length === 0) {
    return {
      deletedAllAt: 0,
      deletedSessions: {},
      sessions: []
    };
  }

  const payload = chunkKeys.map(key => storage[key]).join("");
  log.info(logDir, "readSyncState()", {
    chunkCount: chunkKeys.length,
    payloadSize: calcTextSize(payload),
    chunkSizes: chunkKeys.map(key => ({
      key,
      size: calcTextSize(storage[key] || "")
    }))
  });
  try {
    const parsed = decodeSyncPayload(payload);
    log.info(logDir, "readSyncState() parsed", {
      sessionCount: parsed.sessions?.length || 0,
      deletedSessionCount: Object.keys(parsed.deletedSessions || {}).length,
      deletedAllAt: parsed.deletedAllAt || 0
    });
    return {
      deletedAllAt: parsed.deletedAllAt || 0,
      deletedSessions: parsed.deletedSessions || {},
      sessions: parsed.sessions || []
    };
  } catch (e) {
    log.error(logDir, "readSyncState()", e);
    return {
      deletedAllAt: 0,
      deletedSessions: {},
      sessions: []
    };
  }
};

const writeSyncState = async state => {
  const payload = encodeSyncPayload(state);
  const chunks = splitIntoChunks(payload);
  const storage = await browser.storage.sync.get(null);
  const existingKeys = getSyncChunkKeys(storage);
  const setValue = {};

  chunks.forEach((chunk, index) => {
    setValue[`${syncChunkPrefix}${index}`] = chunk;
  });

  const nextKeys = new Set(Object.keys(setValue));
  const removeKeys = existingKeys.filter(key => !nextKeys.has(key));

  log.info(logDir, "writeSyncState()", {
    chunkCount: chunks.length,
    chunkSizes: chunks.map(chunk => calcTextSize(chunk)),
    removeKeys,
    sessionCount: state.sessions?.length || 0,
    deletedSessionCount: Object.keys(state.deletedSessions || {}).length,
    deletedAllAt: state.deletedAllAt || 0
  });

  if (Object.keys(setValue).length > 0) await browser.storage.sync.set(setValue);
  if (removeKeys.length > 0) await browser.storage.sync.remove(removeKeys);
};

const mergeState = remoteState => {
  const deletedAllAt = Math.max(syncState.deletedAllAt || 0, remoteState.deletedAllAt || 0);
  const deletedSessions = {
    ...(syncState.deletedSessions || {}),
    ...(remoteState.deletedSessions || {})
  };

  for (const [id, deletedAt] of Object.entries(remoteState.deletedSessions || {})) {
    if ((syncState.deletedSessions || {})[id] > deletedAt) {
      deletedSessions[id] = syncState.deletedSessions[id];
    }
  }

  return {
    deletedAllAt,
    deletedSessions,
    sessions: remoteState.sessions || []
  };
};

const mergeSessions = (localSessions, remoteState) => {
  const effectiveState = mergeState(remoteState);
  const remoteSessions = (effectiveState.sessions || []).filter(shouldSyncSession);
  const localSyncableSessions = localSessions.filter(shouldSyncSession);
  const localOtherSessions = localSessions.filter(session => !shouldSyncSession(session));

  const merged = new Map();
  for (const session of localSyncableSessions) {
    const deletedAt = Math.max(
      effectiveState.deletedAllAt || 0,
      effectiveState.deletedSessions?.[session.id] || 0
    );
    if (deletedAt > session.lastEditedTime) continue;
    merged.set(session.id, session);
  }

  for (const session of remoteSessions) {
    const deletedAt = Math.max(
      effectiveState.deletedAllAt || 0,
      effectiveState.deletedSessions?.[session.id] || 0
    );
    if (deletedAt > session.lastEditedTime) continue;

    const current = merged.get(session.id);
    if (!current || current.lastEditedTime < session.lastEditedTime) {
      merged.set(session.id, session);
    }
  }

  return localOtherSessions.concat(Array.from(merged.values()));
};

const sessionsEqual = (left, right) => {
  if (left.length !== right.length) return false;
  const sortById = sessions => [...sessions].sort((a, b) => a.id.localeCompare(b.id));
  const leftSorted = sortById(left);
  const rightSorted = sortById(right);

  return leftSorted.every((session, index) => {
    const other = rightSorted[index];
    return session.id === other.id && session.lastEditedTime === other.lastEditedTime;
  });
};

const scheduleSync = () => {
  if (isSyncSuspended) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncStorage().catch(e => {
      log.error(logDir, "scheduleSync()", e);
    });
  }, 1000);
};

const syncStorage = async () => {
  if (isSyncSuspended) return;
  if (isSyncing) {
    scheduleSync();
    return;
  }
  isSyncing = true;
  try {
    const localSessions = await readAllLocalSessions();
    const syncableSessions = localSessions.filter(session => shouldSyncSession(session) && !isDeletedBySyncState(session));
    log.info(logDir, "syncStorage()", {
      localSessionCount: localSessions.length,
      syncableSessionCount: syncableSessions.length,
      localSessionSummaries: syncableSessions.map(summarizeSession)
    });
    const nextState = {
      deletedAllAt: syncState.deletedAllAt || 0,
      deletedSessions: syncState.deletedSessions || {},
      sessions: syncableSessions
    };
    const currentState = await readSyncState();
    if (JSON.stringify(nextState) === JSON.stringify(currentState)) return;
    await writeSyncState(nextState);
  } catch (e) {
    log.error(logDir, "syncStorage()", e);
  } finally {
    isSyncing = false;
  }
};

const restoreFromSyncStorage = async () => {
  try {
    const remoteState = await readSyncState();
    const localSessions = await readAllLocalSessions();
    const mergedSessions = mergeSessions(localSessions, remoteState);
    log.info(logDir, "restoreFromSyncStorage()", {
      localSessionCount: localSessions.length,
      remoteSessionCount: remoteState.sessions?.length || 0,
      mergedSessionCount: mergedSessions.length,
      localSessionSummaries: localSessions.map(summarizeSession),
      remoteSessionSummaries: (remoteState.sessions || []).map(summarizeSession)
    });

    if (!sessionsEqual(localSessions, mergedSessions)) {
      isSyncSuspended = true;
      try {
        await deleteLocalDatabase();
        for (const session of mergedSessions) {
          await putLocalSession(session);
        }
      } finally {
        isSyncSuspended = false;
      }
    }

    syncState = mergeState(remoteState);
    await syncStorage();
  } catch (e) {
    log.error(logDir, "restoreFromSyncStorage()", e);
  }
};

const SessionStore = {
  init: async (options = {}) => {
    log.log(logDir, "init()");
    if (navigator.storage.persist) navigator.storage.persist();
    await openDatabase();
    if (options.loadSync !== false) await restoreFromSyncStorage();
  },

  DBUpdate: async () => {
    log.log(logDir, "DBUpdate()");
    let sessions;
    try {
      sessions = await SessionStore.getAll();
      await SessionStore.deleteAll(false);
    } catch (e) {
      log.error(logDir, "DBUpdate()", e);
      return;
    }

    for (let session of sessions) {
      await SessionStore.put(session, false).catch(e => {
        log.error(logDir, "DBUpdate()", e);
      });
    }
  },

  put: async (session, shouldSync = true) => {
    log.log(logDir, "put()", session);
    await putLocalSession(session);
    if (shouldSync && !isSyncSuspended) {
      if (shouldSyncSession(session)) {
        delete syncState.deletedSessions[session.id];
      }
      scheduleSync();
    }
  },

  delete: async (id, shouldSync = true) => {
    log.log(logDir, "delete()", id);
    const session = await readLocalSession(id).catch(() => {});
    await deleteLocalSession(id);
    if (shouldSync && !isSyncSuspended && session && shouldSyncSession(session)) {
      syncState.deletedSessions[id] = Date.now();
      scheduleSync();
    }
  },

  deleteAll: async (shouldSync = true) => {
    log.log(logDir, "deleteAll()");
    await deleteLocalDatabase();
    if (shouldSync && !isSyncSuspended) {
      syncState.deletedAllAt = Date.now();
      syncState.deletedSessions = {};
      scheduleSync();
    }
  },

  get: async id => {
    log.log(logDir, "get()", id);
    try {
      const session = await readLocalSession(id);
      log.log(logDir, "=>get()", session);
      return session;
    } catch (e) {
      return Promise.reject(e);
    }
  },

  getAll: async (needKeys = null) => {
    log.log(logDir, "getAll()", needKeys);
    const sessions = await readAllLocalSessions(needKeys);
    log.log(logDir, "=>getAll()", sessions);
    return sessions;
  },

  getAllWithStream: (sendResponse, needKeys, count) => {
    log.log(logDir, "getAllWithStream()", needKeys, count);
    const db = DB;
    const transaction = db.transaction("sessions", "readonly");
    const store = transaction.objectStore("sessions");
    const request = store.openCursor();

    let sessions = [];

    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) {
        let session = {};
        if (needKeys == null) {
          session = cursor.value;
        } else {
          for (let i of needKeys) {
            session[i] = cursor.value[i];
          }
        }

        sessions.push(session);
        if (sessions.length === count) {
          sendResponse(sessions, false);
          sessions = [];
        }
        cursor.continue();
      } else {
        log.log(logDir, "=>getAllWithStream()");
        sendResponse(sessions, true);
      }
    };
    request.onerror = e => {
      log.error(logDir, "getAllWithStream()", e);
    };
  },

  search: async (index, key) => {
    log.log(logDir, "search()", index, key);
    const db = DB;
    const transaction = db.transaction("sessions", "readonly");
    const store = transaction.objectStore("sessions");
    const request = store.index(index).openCursor(key, "next");

    let sessions = [];
    return new Promise(resolve => {
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          sessions.push(cursor.value);
          cursor.continue();
        } else {
          log.log(logDir, "=>search()", sessions);
          resolve(sessions);
        }
      };
      request.onerror = e => {
        log.error(logDir, "search()", e);
        resolve();
      };
    });
  },

  handleSyncStorageChange: async (changes, areaName) => {
    if (areaName !== "sync") return;
    if (!Object.keys(changes).some(key => key.startsWith(syncChunkPrefix))) return;
    if (isSyncSuspended || isSyncing) return;
    await restoreFromSyncStorage();
  }
};

export default SessionStore;
