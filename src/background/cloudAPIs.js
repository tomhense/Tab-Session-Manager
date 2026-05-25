import log from "loglevel";
import { getWebdavClient } from "./cloudAuth";
import { sliceTextByBytes } from "../common/sliceTextByBytes";

const logDir = "background/cloudAPIs";
const indexFileName = "index.json";

const buildError = (code, message) => {
  const error = new Error(message);
  error.code = code;
  return error;
};

const getFileUrl = (baseUrl, fileId) => {
  return `${baseUrl}${encodeURIComponent(fileId)}.json`;
};

const getIndexUrl = baseUrl => {
  return `${baseUrl}${indexFileName}`;
};

const normalizeMetadata = file => {
  const appProperties = file.appProperties || {};
  const tag = Array.isArray(appProperties.tag)
    ? appProperties.tag
    : appProperties.tag
      ? appProperties.tag.split(",")
      : [];
  const lastEditedTime = appProperties.lastEditedTime || 0;
  return {
    ...file,
    appProperties: {
      ...appProperties,
      lastEditedTime,
      tag
    }
  };
};

const parseDirectoryListing = text => {
  const hrefs = [];
  const hrefPattern = /<(?:\w+:)?href>(.*?)<\/(?:\w+:)?href>/gis;
  let match;
  while ((match = hrefPattern.exec(text)) !== null) {
    hrefs.push(match[1]);
  }
  return hrefs;
};

const isSessionFileName = fileName => {
  return fileName.endsWith(".json") && fileName !== indexFileName;
};

const getFileNameFromHref = (baseUrl, href) => {
  let url;
  try {
    url = new URL(href, baseUrl);
  } catch (e) {
    return "";
  }

  const basePath = new URL(baseUrl).pathname;
  if (!url.pathname.startsWith(basePath)) return "";

  const relativePath = url.pathname.slice(basePath.length);
  try {
    return decodeURIComponent(relativePath);
  } catch (e) {
    return "";
  }
};

const listDirectoryHrefs = async (baseUrl, headers) => {
  const response = await fetch(baseUrl, {
    method: "PROPFIND",
    headers: { ...headers, Depth: "1" }
  });

  if (response.status === 401 || response.status === 403) {
    throw buildError("unauthorized", "WebDAV authorization failed");
  }
  if (!response.ok) {
    throw buildError("unreachable", `Failed to list WebDAV directory (${response.status})`);
  }

  const text = await response.text();
  return parseDirectoryListing(text);
};

const writeIndex = async (baseUrl, headers, files) => {
  const url = getIndexUrl(baseUrl);
  const body = JSON.stringify({ files, updatedAt: Date.now() });
  const response = await fetch(url, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body
  });

  if (response.status === 401 || response.status === 403) {
    throw buildError("unauthorized", "WebDAV authorization failed");
  }
  if (!response.ok) {
    throw buildError("write_failed", `Failed to update WebDAV index (${response.status})`);
  }
};

const readIndexCache = async (baseUrl, headers) => {
  const url = getIndexUrl(baseUrl);
  const response = await fetch(url, { headers, method: "GET" });

  if (response.status === 404) {
    return null;
  }
  if (response.status === 401 || response.status === 403) {
    throw buildError("unauthorized", "WebDAV authorization failed");
  }
  if (!response.ok) {
    throw buildError("unreachable", `Failed to read WebDAV index (${response.status})`);
  }

  const result = await response.json();
  const files = Array.isArray(result.files) ? result.files : [];
  return files.map(normalizeMetadata);
};

const syncIndexCache = async (baseUrl, headers, files) => {
  try {
    await writeIndex(baseUrl, headers, files);
  } catch (e) {
    log.warn(logDir, "syncIndexCache()", e);
  }
};

const readSessionFile = async (baseUrl, headers, fileName) => {
  const fileId = fileName.replace(/\.json$/, "");
  const url = getFileUrl(baseUrl, fileId);
  const response = await fetch(url, { headers, method: "GET" });

  if (response.status === 401 || response.status === 403) {
    throw buildError("unauthorized", "WebDAV authorization failed");
  }
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw buildError("unreachable", `Failed to read WebDAV session (${response.status})`);
  }

  const result = await response.json();
  return normalizeMetadata({
    id: fileId,
    name: fileId,
    appProperties: {
      id: result.id || fileId,
      name: result.name || fileId,
      date: result.date || 0,
      lastEditedTime: result.lastEditedTime || 0,
      tag: result.tag || [],
      tabsNumber: result.tabsNumber || 0,
      windowsNumber: result.windowsNumber || 0
    }
  });
};

const rebuildIndexFromDirectory = async (baseUrl, headers) => {
  const hrefs = await listDirectoryHrefs(baseUrl, headers);
  const fileNames = hrefs
    .map(href => getFileNameFromHref(baseUrl, href))
    .filter(Boolean)
    .filter(isSessionFileName);
  const files = [];
  for (const fileName of fileNames) {
    try {
      const file = await readSessionFile(baseUrl, headers, fileName);
      if (file) files.push(file);
    } catch (e) {
      log.warn(logDir, "rebuildIndexFromDirectory()", fileName, e);
    }
  }
  if (hrefs.length === 0) {
    const cachedFiles = await readIndexCache(baseUrl, headers).catch(e => {
      log.warn(logDir, "rebuildIndexFromDirectory() readIndexCache", e);
      return null;
    });
    if (cachedFiles) return cachedFiles;
    throw buildError("unreachable", "Failed to parse WebDAV directory listing");
  }
  await syncIndexCache(baseUrl, headers, files);
  return files;
};

export const listFiles = async () => {
  log.log(logDir, "listFiles()");
  const { baseUrl, headers } = await getWebdavClient();
  const files = await rebuildIndexFromDirectory(baseUrl, headers);
  log.log(logDir, "=>listFiles()", files);
  return files;
};

const buildMetadata = session => ({
  id: session.id,
  name: session.id,
  appProperties: {
    id: session.id,
    name: sliceTextByBytes(session.name, 115),
    date: session.date,
    lastEditedTime: session.lastEditedTime,
    tag: session.tag,
    tabsNumber: session.tabsNumber,
    windowsNumber: session.windowsNumber
  },
  mimeType: "application/json"
});

export const uploadSession = async (session, knownFiles = null) => {
  log.log(logDir, "uploadSession()", session);
  const { baseUrl, headers } = await getWebdavClient();
  const fileUrl = getFileUrl(baseUrl, session.id);
  const response = await fetch(fileUrl, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(session)
  });
  if (response.status === 401 || response.status === 403) {
    throw buildError("unauthorized", "WebDAV authorization failed");
  }
  if (!response.ok) {
    throw buildError("write_failed", `Failed to upload session (${response.status})`);
  }

  const metadata = buildMetadata(session);
  const files = Array.isArray(knownFiles) ? knownFiles : await rebuildIndexFromDirectory(baseUrl, headers);
  const filteredFiles = files.filter(file => file.id !== metadata.id && file.name !== metadata.name);
  const updatedFiles = filteredFiles.concat(normalizeMetadata(metadata));
  await syncIndexCache(baseUrl, headers, updatedFiles);
  return updatedFiles;
};

export const downloadFile = async fileId => {
  log.log(logDir, "downloadFile()", fileId);
  const { baseUrl, headers } = await getWebdavClient();
  const url = getFileUrl(baseUrl, fileId);
  const response = await fetch(url, { headers });

  if (response.status === 401 || response.status === 403) {
    throw buildError("unauthorized", "WebDAV authorization failed");
  }
  if (!response.ok) {
    throw buildError("unreachable", `Failed to download session (${response.status})`);
  }

  const result = await response.json();
  log.log(logDir, "=>downloadFile()", result);
  return result;
};

export const deleteAllFiles = async () => {
  log.log(logDir, "deleteAllFiles()");
  const files = await listFiles();
  for (let file of files) {
    await deleteFile(file.id);
  }
};

export const deleteFile = async (fileId, knownFiles = null) => {
  log.log(logDir, "deleteFiles()", fileId);
  const { baseUrl, headers } = await getWebdavClient();
  const url = getFileUrl(baseUrl, fileId);
  const response = await fetch(url, { method: "DELETE", headers });

  if (response.status === 401 || response.status === 403) {
    throw buildError("unauthorized", "WebDAV authorization failed");
  }
  if (!response.ok && response.status !== 404) {
    throw buildError("delete_failed", `Failed to delete session (${response.status})`);
  }

  const files = Array.isArray(knownFiles) ? knownFiles : await rebuildIndexFromDirectory(baseUrl, headers);
  const filteredFiles = files.filter(file => file.id !== fileId && file.name !== fileId);
  await syncIndexCache(baseUrl, headers, filteredFiles);
  return filteredFiles;
};
