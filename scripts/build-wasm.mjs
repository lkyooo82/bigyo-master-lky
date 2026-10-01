// Builds crates/diff-wasm and writes the JS bindings to packages/engine/wasm.
// Needs the wasm32-unknown-unknown target and a wasm-bindgen CLI matching the crate version.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: "inherit" });

run("cargo", ["build", "-p", "diff-wasm", "--target", "wasm32-unknown-unknown", "--release"]);
run("wasm-bindgen", [
  "target/wasm32-unknown-unknown/release/diff_wasm.wasm",
  "--target", "web",
  "--out-dir", "packages/engine/wasm",
]);
