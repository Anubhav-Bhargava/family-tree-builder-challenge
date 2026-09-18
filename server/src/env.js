// Loads server/.env by path rather than from process.cwd(), so the server works
// however it is started (npm run dev, a debugger launched from the repo root, ...).
// Imported first in index.js: ES modules evaluate imports before any other code,
// so this must be an import, not a call inside index.js.
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

dotenv.config({ path: fileURLToPath(new URL("../.env", import.meta.url)) });
