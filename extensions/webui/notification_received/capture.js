import { store } from "/plugins/notification_logs/webui/logs-store.js";

export default function (event) {
  return store.capture(event);
}
