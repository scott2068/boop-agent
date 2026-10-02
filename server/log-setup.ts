import { appLog } from "./app-log.js";
appLog.configureSecrets(process.env);
appLog.installConsoleCapture("server");
appLog.append("info", "server", "Boop server starting.");
