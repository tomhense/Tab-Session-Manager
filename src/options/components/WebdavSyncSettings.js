import React, { useEffect, useState } from "react";
import browser from "webextension-polyfill";
import log from "loglevel";
import { getSettings } from "src/settings/settings";

const logDir = "options/components/WebdavSyncSettings";

const getPermissionOrigin = rawUrl => {
  const url = new URL(rawUrl);
  return `${url.origin}/*`;
};

export default function WebdavSyncSettings() {
  const [isConnected, setIsConnected] = useState(!!getSettings("webdavConnected"));
  const [status, setStatus] = useState("");
  const [isBusy, setIsBusy] = useState(false);

  useEffect(() => {
    const handleStorageChange = changes => {
      if (!changes.Settings) return;
      const newSettings = changes.Settings.newValue;
      if (newSettings.webdavConnected !== undefined) {
        setIsConnected(!!newSettings.webdavConnected);
        if (!newSettings.webdavConnected) setStatus("");
      }
    };
    browser.storage.local.onChanged.addListener(handleStorageChange);
    return () => browser.storage.local.onChanged.removeListener(handleStorageChange);
  }, []);

  const validateConfig = () => {
    const url = getSettings("webdavUrl") || "";
    const username = getSettings("webdavUsername") || "";
    if (!url || !username) throw new Error("missing_config");
    getPermissionOrigin(url);
  };

  const requestPermissions = async () => {
    const url = getSettings("webdavUrl") || "";
    const origin = getPermissionOrigin(url);
    const isGranted = await browser.permissions.request({ origins: [origin] });
    if (!isGranted) throw new Error("permission_denied");
  };

  const handleConnect = async () => {
    log.info(logDir, "handleConnect()");
    setIsBusy(true);
    setStatus("");
    try {
      validateConfig();
      await requestPermissions();
      const isSucceeded = await browser.runtime.sendMessage({ message: "connectWebdav" });
      if (isSucceeded) {
        setIsConnected(true);
        setStatus(browser.i18n.getMessage("webdavConnectedLabel"));
      } else {
        setIsConnected(false);
        setStatus(browser.i18n.getMessage("webdavConnectionErrorLabel"));
      }
    } catch (e) {
      log.error(logDir, "handleConnect()", e);
      let messageKey = "webdavConnectionErrorLabel";
      if (e.message === "missing_config") messageKey = "webdavMissingConfigLabel";
      else if (e.message === "permission_denied") messageKey = "webdavPermissionErrorLabel";
      setIsConnected(false);
      setStatus(browser.i18n.getMessage(messageKey));
    } finally {
      setIsBusy(false);
    }
  };

  const handleDisconnect = async () => {
    log.info(logDir, "handleDisconnect()");
    setIsBusy(true);
    await browser.runtime.sendMessage({ message: "disconnectWebdav" });
    setIsConnected(false);
    setStatus(browser.i18n.getMessage("webdavDisconnectedLabel"));
    setIsBusy(false);
  };

  const buttonLabel = isConnected
    ? browser.i18n.getMessage("webdavDisconnectLabel")
    : browser.i18n.getMessage("webdavConnectLabel");

  const caption = status ||
    browser.i18n.getMessage(isConnected ? "webdavConnectedLabel" : "webdavDisconnectedLabel");

  return (
    <div className={`webdavSyncSettings ${isConnected ? "connected" : ""}`}>
      <input
        type="button"
        value={buttonLabel}
        onClick={isConnected ? handleDisconnect : handleConnect}
        disabled={isBusy}
      />
      <p className={`caption ${isConnected ? "success" : ""}`}>{caption}</p>
    </div>
  );
}
