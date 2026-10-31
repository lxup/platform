#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(dir, "..", "src", "index.ts");

const child = spawn("bun", ["run", entry, ...process.argv.slice(2)], {
  stdio: "inherit",
  cwd: path.join(dir, ".."),
});

child.on("exit", (code) => process.exit(code ?? 0));
