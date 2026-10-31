import { execa, type Options } from "execa";
import type { ListrTaskWrapper } from "listr2";

/**
 * Run a command, streaming stdout/stderr lines into the Listr2 task's live
 * output area so long-running steps (helm installs, talosctl apply, etc.)
 * show progress instead of looking frozen.
 */
export async function run(
  task: ListrTaskWrapper<any, any, any>,
  file: string,
  args: string[],
  options: Options = {},
) {
  const subprocess = execa(file, args, {
    ...options,
    env: { ...process.env, ...options.env },
  });

  subprocess.stdout?.on("data", (chunk: Buffer) => {
    task.output = chunk.toString().trim();
  });
  subprocess.stderr?.on("data", (chunk: Buffer) => {
    task.output = chunk.toString().trim();
  });

  return subprocess;
}

/** Run a command and just return stdout (for commands whose output we parse). */
export async function capture(file: string, args: string[], options: Options = {}) {
  const { stdout } = await execa(file, args, {
    ...options,
    env: { ...process.env, ...options.env },
  });
  return stdout;
}

/**
 * Checks PATH resolution only — not `<bin> --version`, since that flag
 * isn't consistently supported (talosctl and kubectl don't take a bare
 * `--version`) and gave false negatives for tools that were actually
 * installed.
 */
export async function commandExists(file: string): Promise<boolean> {
  try {
    await execa("which", [file]);
    return true;
  } catch {
    return false;
  }
}
