import browser from "webextension-polyfill";
import moment from "moment";
import log from "loglevel";
import Sessions from "./sessions.js";
import { updateSession } from "./save.js";

const logDir = "background/tag";

export async function addTag(id, tag) {
  log.log(logDir, "addTag()", id, tag);
  let session = await Sessions.get(id).catch(() => {});
  if (session == undefined) return;

  const beginningAndEndSpaces = /(^( |　)*)|(( |　)*$)/g;
  const multipleSpaces = /( )+/g;
  tag = tag.replace(beginningAndEndSpaces, "");
  tag = tag.replace(multipleSpaces, " ");

  const isNotEqual = value => {
    return value != tag;
  };
  const reservedTag = [
    "regular",
    "winClose",
    "browserExit",
    "temp",
    "_displayAll",
    "_user",
    "_auto",
    browser.i18n.getMessage("regularSaveSessionName"),
    browser.i18n.getMessage("winCloseSessionName"),
    browser.i18n.getMessage("browserExitSessionName")
  ];
  const currentTags = session.tag;
  if (!reservedTag.every(isNotEqual)) return;
  if (!currentTags.every(isNotEqual)) return;

  const onlySpaces = /^( |　)*$/;
  if (onlySpaces.test(tag)) return;

  session.tag.push(tag);
  updateSession(session);
}

export async function removeTag(id, tag) {
  log.log(logDir, "removeTag()", id, tag);
  let session = await Sessions.get(id).catch(() => {});
  if (session == undefined) return;

  const isNotEqual = value => {
    return value != tag;
  };
  const currentTags = session.tag;
  if (currentTags.every(isNotEqual)) return;

  session.tag = session.tag.filter(element => {
    return element != tag;
  });

  updateSession(session);
}

//指定されたタグを含むセッションを新しい順に取得 needKeysにはtag, dateが必須
export async function getSessionsByTag(tag, needKeys = null) {
  log.log(logDir, "getSessionsByTag()", tag, needKeys);
  const newestSort = (a, b) => {
    return moment(b.date).unix() - moment(a.date).unix();
  };
  const isIncludesTag = (element, index, array) => {
    return element.tag.includes(tag);
  };

  let sessions = await Sessions.getAll(needKeys).catch(() => {});
  sessions = sessions.filter(isIncludesTag);
  sessions.sort(newestSort);

  return sessions;
}
