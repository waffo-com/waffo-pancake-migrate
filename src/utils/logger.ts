import chalk from "chalk";
import { audit, redact } from "./audit.js";

function message(level: string, prefix: string, text: string) {
  const safe = redact(text);
  audit(`log.${level}`, { message: safe });
  console.log(prefix, safe);
}

export const log = {
  info: (msg: string) => message("info", chalk.blue("ℹ"), msg),
  success: (msg: string) => message("success", chalk.green("✔"), msg),
  warn: (msg: string) => message("warn", chalk.yellow("⚠"), msg),
  error: (msg: string) => message("error", chalk.red("✖"), msg),
  dim: (msg: string) => console.log(chalk.dim(redact(msg))),
  blank: () => console.log(),
};
