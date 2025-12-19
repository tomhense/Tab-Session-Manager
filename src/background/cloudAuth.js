import log from "loglevel";
import { getSettings, setSettings } from "../settings/settings";

const logDir = "background/cloudAuth";

const buildError = (code, message) => {
  const error = new Error(message);
  error.code = code;
  return error;
};

const normalizeBaseUrl = rawUrl => {
  const trimmedUrl = rawUrl?.trim();
  if (!trimmedUrl) throw buildError("missing_config", "WebDAV URL is empty");

  let normalizedUrl;
  try {
    normalizedUrl = new URL(trimmedUrl).toString();
  } catch (e) {
    throw buildError("invalid_config", "WebDAV URL is invalid");
  }

  if (!normalizedUrl.endsWith("/")) normalizedUrl += "/";
  return normalizedUrl;
};

const encodeBasicAuth = (username, password) => {
  // Support non-ASCII credentials by encoding into UTF-8 before btoa.
  const credentials = `${username || ""}:${password || ""}`;
  const utf8Credentials = unescape(encodeURIComponent(credentials));
  return btoa(utf8Credentials);
};

export const getWebdavConfig = () => {
  const url = getSettings("webdavUrl") || "";
  const username = getSettings("webdavUsername") || "";
  const password = getSettings("webdavPassword") || "";

  return { url, username, password };
};

const ensureWebdavConfig = config => {
  if (!config.url) throw buildError("missing_config", "WebDAV URL is empty");
  if (!config.username) throw buildError("missing_config", "WebDAV username is empty");
};

const ensureWebdavDirectory = async (baseUrl, headers) => {
  const probeHeaders = {
    ...headers,
    Depth: "0"
  };
  const response = await fetch(baseUrl, { method: "PROPFIND", headers: probeHeaders });
  if (response.status === 404) {
    const createRes = await fetch(baseUrl, { method: "MKCOL", headers });
    if (!createRes.ok && createRes.status !== 405) {
      throw buildError("create_failed", `Failed to create WebDAV directory (${createRes.status})`);
    }
    return;
  }

  if (response.status === 401 || response.status === 403) {
    throw buildError("unauthorized", "WebDAV authorization failed");
  }

  if (!response.ok) {
    throw buildError("unreachable", `WebDAV directory probe failed (${response.status})`);
  }
};

export const getWebdavClient = async () => {
  log.log(logDir, "getWebdavClient()");
  const config = getWebdavConfig();
  ensureWebdavConfig(config);
  const baseUrl = normalizeBaseUrl(config.url);
  const headers = {
    Authorization: `Basic ${encodeBasicAuth(config.username, config.password)}`
  };
  await ensureWebdavDirectory(baseUrl, headers);

  return {
    baseUrl,
    headers,
    username: config.username
  };
};

export const connectWebdav = async () => {
  log.log(logDir, "connectWebdav()");
  try {
    const { baseUrl, headers, username } = await getWebdavClient();
    // Touch the index file to ensure we can read/write within the directory.
    const indexUrl = `${baseUrl}index.json`;
    await fetch(indexUrl, { method: "HEAD", headers }).catch(() => { });

    await setSettings("webdavConnected", true);
    await setSettings("signedInEmail", username || baseUrl);
    await setSettings("lastSyncTime", 0);
    await setSettings("removedQueue", []);
    return true;
  } catch (e) {
    log.error(logDir, "connectWebdav()", e);
    throw e;
  }
};

export const disconnectWebdav = async () => {
  log.log(logDir, "disconnectWebdav()");
  await setSettings("webdavConnected", false);
  await setSettings("signedInEmail", "");
  await setSettings("lastSyncTime", 0);
  await setSettings("removedQueue", []);
  return true;
};
