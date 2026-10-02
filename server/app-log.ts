import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
export const appLog = require("../scripts/log-store.cjs") as {
  append(level: "info" | "warning" | "error", source: string, message: string): void;
  installConsoleCapture(source: string): void;
  configureSecrets(env: NodeJS.ProcessEnv): void;
};
