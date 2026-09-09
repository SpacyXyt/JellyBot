import { initDb } from "./db.js";
import { initializeDiscord } from "./discord.js";
import { startWeb } from "./web.js";

async function main() {
  await initDb();
  await initializeDiscord();
  startWeb();

  console.log("Bot connected.");
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
