import log from "loglevel";
import Sessions from "./sessions.js";
import { saveSession } from "./save.js";
import { getSettings, setSettings } from "../settings/settings";

const logDir = "background/import";

export default async function importSessions(importedSessions) {
  log.log(logDir, "import()", importedSessions);

  //同一セッションが存在しなければインポートする
  const savePromises = [];
  for (let importedSession of importedSessions) {
    const currentSessions = await Sessions.search("date", importedSession.date);

    const isSameSession = session =>
      session.id == importedSession.id && session.lastEditedTime >= importedSession.lastEditedTime;
    const existsSameSession = currentSessions.some(isSameSession);
    if (existsSameSession) continue;

    importedSession.lastEditedTime = Date.now();
    savePromises.push(saveSession(importedSession));
  }

  if (!savePromises.length) return;

  await Promise.allSettled(savePromises);
  if (getSettings("webdavConnected")) {
    await setSettings("lastSyncTime", 0);
  }
}
