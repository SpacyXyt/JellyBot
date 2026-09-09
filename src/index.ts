import { config } from "./config.js";
import { initDb } from "./db.js";
import { client, handleInteraction, registerCommands } from "./discord.js";
import { createCheckout } from "./stripe.js";
import { startWeb } from "./web.js";

async function main() {
  await initDb();
  await registerCommands();

  client.on("interactionCreate", async interaction => {
    try {
      await handleInteraction(interaction);
    } catch (error) {
      console.error("Discord interaction error:", error);

      if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: "Une erreur est survenue.",
          ephemeral: true
        }).catch(() => undefined);
      }
    }
  });

  await client.login(config.discordToken);
  startWeb();

  console.log("Bot connected.");
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
