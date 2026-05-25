import moment from "moment";
import { v4 as uuidv4 } from "uuid";

const isArray = o => {
  return Object.prototype.toString.call(o) === "[object Array]";
};

export const isTabSessionManagerExport = file => {
  if (!isArray(file)) return false;

  const correctKeys = ["windows", "tabsNumber", "name", "date", "tag", "sessionStartTime"];
  for (const session of file) {
    const sessionKeys = Object.keys(session);
    const isIncludes = value => {
      return sessionKeys.includes(value);
    };
    if (!correctKeys.every(isIncludes)) return false;
  }
  return true;
};

export const normalizeTabSessionManagerSessions = file => {
  for (const session of file) {
    //ver1.9.2以前のセッションのタグを配列に変更
    if (!Array.isArray(session.tag)) {
      session.tag = session.tag.split(" ");
    }
    //ver1.9.2以前のセッションにUUIDを追加 タグからauto, userを削除
    if (!session["id"]) {
      session["id"] = uuidv4();

      session.tag = session.tag.filter(element => {
        return !(element == "user" || element == "auto");
      });
    }
    //windowsNumberを追加
    if (session.windowsNumber === undefined) {
      session.windowsNumber = Object.keys(session.windows).length;
    }
    //ver4.0.0以前のdateをunix msに変更
    if (typeof session.date !== "number") {
      session.date = moment(session.date).valueOf();
    }
    //ver6.0.0以前のセッションにlastEditedTimeを追加
    if (session.lastEditedTime === undefined) {
      session.lastEditedTime = session.date;
    }
  }
  return file;
};
