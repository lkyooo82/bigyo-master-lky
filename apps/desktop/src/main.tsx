import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createTauriEngine } from "@bigyo/engine/tauri";
import { App } from "@bigyo/ui";
import "@bigyo/ui/styles.css";
import { desktopFiles } from "./files";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App engine={createTauriEngine()} files={desktopFiles} />
  </StrictMode>,
);
