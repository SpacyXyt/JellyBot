import { registerCommands } from "./discord.js";

registerCommands()
  .then(() => console.log("Discord commands registered."))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
