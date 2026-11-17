import { Command } from "commander";
import { stripeCommand } from "./commands/stripe.js";
import { dodoCommand } from "./commands/dodo.js";
import { creemCommand } from "./commands/creem.js";

export function createCli(): Command {
  const program = new Command();

  program
    .name("pancake-migrate")
    .description("Migrate products and settings to Waffo Pancake")
    .version("0.2.0");

  program.addCommand(stripeCommand());
  program.addCommand(creemCommand());
  program.addCommand(dodoCommand());

  // Default action: interactive source selection
  program.action(async () => {
    const { selectSource } = await import("./prompts/interactive.js");
    const source = await selectSource();

    await program.commands
      .find((c) => c.name() === source)!
      .parseAsync([], { from: "user" });
  });

  return program;
}
