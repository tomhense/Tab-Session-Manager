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

const normalizeMetadata = file => {
  const appProperties = file.appProperties || {};
  const tag = Array.isArray(appProperties.tag) ? appProperties.tag : (appProperties.tag ? appProperties.tag.split(",") : []);
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

const readIndex = async (baseUrl, headers) => {
  const url = `${baseUrl}${indexFileName}`;
  const response = await fetch(url, { headers, method: "GET" });

  if (response.status === 404) {
    return [];
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

const writeIndex = async (baseUrl, headers, files) => {
  const url = `${baseUrl}${indexFileName}`;
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

export const listFiles = async () => {
  log.log(logDir, "listFiles()");
  const { baseUrl, headers } = await getWebdavClient();
  const files = await readIndex(baseUrl, headers);
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

export const uploadSession = async session => {
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
  const files = await readIndex(baseUrl, headers);
  const filteredFiles = files.filter(file => file.id !== metadata.id && file.name !== metadata.name);
  await writeIndex(baseUrl, headers, filteredFiles.concat(metadata));
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

export const deleteFile = async fileId => {
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

  const files = await readIndex(baseUrl, headers);
  const filteredFiles = files.filter(file => file.id !== fileId && file.name !== fileId);
  await writeIndex(baseUrl, headers, filteredFiles);
};
