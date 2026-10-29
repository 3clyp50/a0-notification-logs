import { createStore } from "/js/AlpineStore.js";
import { openModal } from "/js/modals.js";
import { formatDateTime } from "/js/time-utils.js";
import { createActionButton, copyToClipboard } from "/components/messages/action-buttons/simple-action-buttons.js";
import { store as notifications } from "/components/notifications/notification-store.js";
import { toRecord, saveRecord, readRecords, clearRecords } from "/plugins/notification_logs/webui/history.js";

const memory = new Map();
let reportedStorageError = false;
let channel;
let pending = Promise.resolve();

function changed() {
  channel?.postMessage("changed");
  if (store.openCount) void store.refresh();
}

export const store = createStore("notificationLogs", {
  entries: [],
  query: "",
  severity: "",
  limit: 100,
  loading: false,
  openCount: 0,

  init() {
    if (!channel && typeof BroadcastChannel !== "undefined") {
      channel = new BroadcastChannel("a0_notification_logs");
      channel.onmessage = () => { if (this.openCount) void this.refresh(); };
    }
  },

  capture({ notification, source }) {
    if (notification.group === "notification_logs") return pending;
    const record = toRecord(notification, source);
    pending = pending.then(async () => {
      try {
        if (await saveRecord(record)) changed();
      } catch (error) {
        memory.set(record.id, record);
        if (memory.size > 1000) memory.delete(memory.keys().next().value);
        this.storageError(error);
        if (this.openCount) await this.refresh();
      }
    });
    return pending;
  },

  storageError(error) {
    if (reportedStorageError) return;
    reportedStorageError = true;
    console.warn("Notification Logs storage:", error);
    notifications.addFrontendToastOnly("warning", "Notification history could not be saved. New entries are kept until this page closes.", "Notification Logs", 0, "notification_logs");
  },

  show() {
    return openModal("/plugins/notification_logs/webui/logs.html");
  },

  async mount() {
    this.openCount++;
    this.query = "";
    this.severity = "";
    this.limit = 100;
    await pending;
    await this.refresh();
  },

  unmount() {
    this.openCount = Math.max(0, this.openCount - 1);
    if (!this.openCount) this.entries = [];
  },

  async refresh() {
    if (!this.openCount) return;
    this.loading = true;
    try {
      const records = new Map((await readRecords()).map(entry => [entry.id, entry]));
      if (!this.openCount) return;
      for (const [id, entry] of memory) records.set(id, entry);
      this.entries = [...records.values()].sort((a, b) => b.time - a.time);
    } catch (error) {
      this.storageError(error);
      this.entries = [...memory.values()].sort((a, b) => b.time - a.time);
    } finally {
      this.loading = false;
    }
  },

  get filtered() {
    const query = this.query.trim().toLowerCase();
    return this.entries.filter(entry => (!this.severity || entry.type === this.severity) &&
      (!query || `${entry.title}\n${entry.message}\n${entry.detail}`.toLowerCase().includes(query)));
  },

  get visible() {
    return this.filtered.slice(0, this.limit);
  },

  date(entry) { return formatDateTime(new Date(entry.time)); },

  icon(type) {
    return { error: "error", warning: "warning", success: "check_circle", progress: "hourglass_empty", info: "info" }[type] || "info";
  },

  copyButton(entry) {
    const button = createActionButton("copy", "", () => copyToClipboard([
      `${new Date(entry.time).toISOString()} · ${entry.type} · ${entry.source}`,
      entry.title, entry.message, entry.detail,
    ].filter(Boolean).join("\n\n")));
    button.append("Copy");
    return button;
  },

  async clear() {
    await pending;
    try {
      await clearRecords();
      memory.clear();
      this.entries = [];
      changed();
    } catch (error) {
      notifications.addFrontendToastOnly("error", "Could not clear notification history.", "Notification Logs", 8, "notification_logs");
      console.error("Notification Logs clear:", error);
    }
  },
});
