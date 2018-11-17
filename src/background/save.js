import browser from "webextension-polyfill";
import uuidv4 from "uuid/v4";
import log from "loglevel";
import { SessionStartTime } from "./background.js";
import Sessions from "./sessions.js";
import { getSettings } from "src/settings/settings";
import { returnReplaceParameter } from "./replace.js";
import { getSessionsByTag } from "./tag.js";

const logDir = "background/save";

export function saveCurrentSession(name, tag, property) {
  log.log(logDir, "saveCurrentSession()", name, tag, property);
  return new Promise(async (resolve, reject) => {
    const exit = () => {
      log.log(logDir, "saveCurrentSession() exit()");
      reject();
      return;
    };

    try {
      let session = await loadCurrentSession(name, tag, property);

      //定期保存のセッションが変更されていなければ終了
      if (tag.includes("regular")) {
        const isChanged = await isChangedAutoSaveSession(session);
        if (!isChanged) {
          return exit();
        }
      }

      await saveSession(session);
      resolve();
    } catch (e) {
      log.error(logDir, "saveCurrentSession()", e);
      exit();
    }
  });
}

export async function loadCurrentSession(name, tag, property) {
  log.log(logDir, "loadCurrentSession()", name, tag, property);
  let session = {
    windows: {},
    windowsNumber: 0,
    windowsInfo: {},
    tabsNumber: 0,
    name: name,
    date: Date.now(),
    tag: tag,
    sessionStartTime: SessionStartTime,
    id: uuidv4()
  };

  let queryInfo = {};
  switch (property) {
    case "saveAllWindows":
      break;
    case "saveOnlyCurrentWindow":
      queryInfo.currentWindow = true;
  }

  const tabs = await browser.tabs.query(queryInfo);
  for (let tab of tabs) {
    //プライベートタブを無視
    if (!getSettings("ifSavePrivateWindow")) {
      if (tab.incognito) {
        continue;
      }
    }

    if (session.windows[tab.windowId] == undefined) session.windows[tab.windowId] = {};

    //replacedPageなら元のページを保存
    const parameter = returnReplaceParameter(tab.url);
    if (parameter.isReplaced) {
      tab.url = parameter.url;
    }

    session.windows[tab.windowId][tab.id] = tab;
    session.tabsNumber++;
  }

  session.windowsNumber = Object.keys(session.windows).length;

  for (let i in session.windows) {
    const window = await browser.windows.get(parseInt(i));
    session.windowsInfo[i] = window;
  }

  return new Promise((resolve, reject) => {
    if (session.tabsNumber > 0) resolve(session);
    else reject();
  });
}

//前回の自動保存からタブが変わっているか判定
//自動保存する必要があればtrue
async function isChangedAutoSaveSession(session) {
  log.log(logDir, "isChangedAutoSaveSession()");
  const regularSessions = await getSessionsByTag("regular", ["id", "tag", "date", "windows"]);
  if (regularSessions.length == 0) return true;

  const tabsToString = session => {
    let retArray = [];
    for (let windowNo in session.windows) {
      retArray.push(windowNo);
      for (let tabNo in session.windows[windowNo]) {
        const tab = session.windows[windowNo][tabNo];
        retArray.push(tab.id, tab.url);
      }
    }
    return retArray.toString();
  };

  //前回保存時とタブが異なればtrue
  return tabsToString(regularSessions[0]) != tabsToString(session);
}

async function sendMessage(message, id = null) {
  await browser.runtime
    .sendMessage({
      message: message,
      id: id
    })
    .catch(() => {});
}

export async function saveSession(session, isSendResponce = true) {
  log.log(logDir, "saveSession()", session, isSendResponce);
  try {
    await Sessions.put(session);
    if (isSendResponce) sendMessage("saveSession", session.id);
  } catch (e) {}
}

export async function removeSession(id, isSendResponce = true) {
  log.log(logDir, "removeSession()", id, isSendResponce);
  try {
    await Sessions.delete(id);
    if (isSendResponce) sendMessage("deleteSession", id);
  } catch (e) {}
}

export async function updateSession(session, isSendResponce = true) {
  log.log(logDir, "updateSession()", session, isSendResponce);
  try {
    await Sessions.put(session);
    if (isSendResponce) sendMessage("updateSession", session.id);
  } catch (e) {}
}

export async function renameSession(id, name) {
  log.log(logDir, "renameSession()", id, name);
  let session = await Sessions.get(id).catch(() => {});
  if (session == undefined) return;
  session.name = name.trim();
  updateSession(session);
}

export async function deleteAllSessions() {
  log.log(logDir, "deleteAllSessions()");
  try {
    await Sessions.deleteAll();
    sendMessage("deleteAll");
  } catch (e) {}
}
