import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder
} from "discord.js";
import { config } from "./config.js";
import { getSubscription } from "./db.js";

export const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

export const commands = [
  new SlashCommandBuilder()
    .setName("abonnement")
    .setDescription("Créer le lien d'abonnement"),

  new SlashCommandBuilder()
    .setName("compte")
    .setDescription("Voir l'état de votre abonnement Jellyfin"),

  new SlashCommandBuilder()
    .setName("statut")
    .setDescription("Voir l'état de votre abonnement")
].map(command => command.toJSON());

export async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(config.discordToken);
  await rest.put(
    Routes.applicationGuildCommands(config.discordClientId, config.discordGuildId),
    { body: commands }
  );
}

export async function syncDiscordRole(discordUserId: string, active: boolean) {
  const guild = await client.guilds.fetch(config.discordGuildId);
  const member = await guild.members.fetch(discordUserId).catch(() => null);
  if (!member) return;

  if (active) {
    await member.roles.add(config.subscriberRoleId);
  } else {
    await member.roles.remove(config.subscriberRoleId).catch(() => undefined);
  }
}

export async function handleInteraction(interaction: any, createCheckout: (id: string) => Promise<string>) {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "abonnement") {
    const url = await createCheckout(interaction.user.id);
    await interaction.reply({
      content: `Voici le lien pour gérer votre abonnement : ${url}`,
      ephemeral: true
    });
    return;
  }

  const subscription = await getSubscription(interaction.user.id);

  if (interaction.commandName === "statut") {
    await interaction.reply({
      content: subscription
        ? `Statut : **${subscription.status}**`
        : "Aucun abonnement enregistré.",
      ephemeral: true
    });
    return;
  }

  if (interaction.commandName === "compte") {
    if (!subscription || !subscription.jellyfin_user_id) {
      await interaction.reply({
        content: "Votre compte Jellyfin n'est pas encore activé.",
        ephemeral: true
      });
      return;
    }

    await interaction.reply({
      content: `Votre accès Jellyfin est associé à votre compte Discord. Le serveur est accessible uniquement via le réseau privé prévu par l'administrateur.`,
      ephemeral: true
    });
  }
}
