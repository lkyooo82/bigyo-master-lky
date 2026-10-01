import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createWasmEngine } from "@bigyo/engine/wasm";
import { App } from "@bigyo/ui";
import "@bigyo/ui/styles.css";
import { browserFiles } from "./files";

const engine = await createWasmEngine();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App engine={engine} files={browserFiles} />
  </StrictMode>,
);
