const DATABASE = "a0_notification_logs";
const LIMIT = 1000;
let database;

function openDatabase() {
  if (!database) {
    database = new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE, 1);
      request.onupgradeneeded = () => {
        const entries = request.result.createObjectStore("entries", { keyPath: "id" });
        entries.createIndex("time", "time");
        request.result.createObjectStore("meta");
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("Close other Agent Zero tabs to open notification history."));
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); database = null; };
        resolve(db);
      };
    }).catch(error => { database = null; throw error; });
  }
  return database;
}

function completed(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onabort = transaction.onerror = () => reject(transaction.error || new Error("Notification history transaction failed."));
  });
}

export function plainText(html = "") {
  const template = document.createElement("template");
  template.innerHTML = String(html);
  template.content.querySelectorAll("script, style, button, input, select, textarea, x-icon").forEach(el => el.remove());
  template.content.querySelectorAll("br").forEach(el => el.replaceWith("\n"));
  template.content.querySelectorAll("p, div, li, pre, tr, h1, h2, h3, h4").forEach(el => el.append("\n"));
  return template.content.textContent.replace(/\n{3,}/g, "\n\n").trim();
}

export function toRecord(notification, source) {
  const parsed = Date.parse(notification.timestamp);
  return {
    id: JSON.stringify([source, notification.id, notification.timestamp]),
    time: source === "backend" && Number.isFinite(parsed) ? parsed : Date.now(),
    source,
    type: ["error", "warning", "info", "success", "progress"].includes(notification.type) ? notification.type : "info",
    title: String(notification.title || ""),
    message: plainText(notification.message),
    detail: plainText(notification.detail),
  };
}

export async function saveRecord(record) {
  const db = await openDatabase();
  const tx = db.transaction(["entries", "meta"], "readwrite");
  const done = completed(tx);
  const entries = tx.objectStore("entries");
  const cutoff = tx.objectStore("meta").get("clearedAt");
  let saved = false;
  cutoff.onsuccess = () => {
    if (record.time <= (cutoff.result?.[record.source] || 0)) return;
    const existing = entries.get(record.id);
    existing.onsuccess = () => {
      if (existing.result && JSON.stringify(existing.result) === JSON.stringify(record)) return;
      entries.put(record);
      saved = true;
      const count = entries.count();
      count.onsuccess = () => {
        let excess = count.result - LIMIT;
        if (excess <= 0) return;
        const cursor = entries.index("time").openCursor();
        cursor.onsuccess = () => {
          if (!cursor.result || excess <= 0) return;
          cursor.result.delete();
          excess--;
          cursor.result.continue();
        };
      };
    };
  };
  await done;
  return saved;
}

export async function readRecords() {
  const db = await openDatabase();
  const tx = db.transaction("entries", "readonly");
  const done = completed(tx);
  const request = tx.objectStore("entries").getAll();
  await done;
  return request.result.sort((a, b) => b.time - a.time || a.id.localeCompare(b.id));
}

export async function clearRecords() {
  const db = await openDatabase();
  const tx = db.transaction(["entries", "meta"], "readwrite");
  const done = completed(tx);
  const entries = tx.objectStore("entries");
  const meta = tx.objectStore("meta");
  const previous = meta.get("clearedAt");
  previous.onsuccess = () => {
    const records = entries.getAll();
    records.onsuccess = () => {
      const backend = records.result.filter(entry => entry.source === "backend")
        .reduce((latest, entry) => Math.max(latest, entry.time), previous.result?.backend || 0);
      entries.clear();
      meta.put({ frontend: Date.now(), backend }, "clearedAt");
    };
  };
  await done;
}
