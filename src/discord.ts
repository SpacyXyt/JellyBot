import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type ButtonInteraction,
  type Interaction,
  type Message
} from "discord.js";

import { config } from "./config.js";
import { createCheckout } from "./stripe.js";
import { getSubscription } from "./db.js";

export const client =
  new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages
    ]
  });

/*
 * ============================================================
 * COMMANDES
 * ============================================================
 */

export const commands = [
  new SlashCommandBuilder()
    .setName("abonnement")
    .setDescription(
      "Créer le lien d'abonnement"
    ),

  new SlashCommandBuilder()
    .setName("compte")
    .setDescription(
      "Voir l'état de votre abonnement Jellyfin"
    ),

  new SlashCommandBuilder()
    .setName("statut")
    .setDescription(
      "Voir l'état de votre abonnement"
    )
].map(command =>
  command.toJSON()
);

/*
 * ============================================================
 * REGISTER COMMANDS
 * ============================================================
 */

export async function registerCommands() {
  const rest =
    new REST({
      version: "10"
    }).setToken(
      config.discordToken
    );

  await rest.put(
    Routes.applicationGuildCommands(
      config.discordClientId,
      config.discordGuildId
    ),
    {
      body: commands
    }
  );

  console.log(
    "Discord slash commands registered."
  );
}

/*
 * ============================================================
 * DISCORD ROLE
 * ============================================================
 */

export async function syncDiscordRole(
  discordUserId: string,
  active: boolean
) {
  try {
    const guild =
      await client.guilds.fetch(
        config.discordGuildId
      );

    const member =
      await guild.members
        .fetch(discordUserId)
        .catch(() => null);

    if (!member) {
      console.log(
        `Discord member ${discordUserId} not found.`
      );

      return;
    }

    if (active) {
      await member.roles.add(
        config.subscriberRoleId
      );
    } else {
      await member.roles
        .remove(
          config.subscriberRoleId
        )
        .catch(() => undefined);
    }
  } catch (error) {
    console.error(
      "Discord role sync error:",
      error
    );
  }
}

/*
 * ============================================================
 * SUBSCRIBE CHANNEL
 * ============================================================
 */

async function deleteAllMessages(
  channel: any
) {
  let before: string | undefined;

  while (true) {
    const messages =
      await channel.messages.fetch({
        limit: 100,
        ...(before
          ? { before }
          : {})
      });

    if (messages.size === 0) {
      break;
    }

    for (
      const message of messages.values()
    ) {
      try {
        await message.delete();
      } catch {
        /*
         * Le message peut avoir déjà été supprimé
         * ou être trop ancien.
         */
      }
    }

    const last =
      messages.last();

    if (!last) {
      break;
    }

    before = last.id;

    if (messages.size < 100) {
      break;
    }
  }
}

export async function setupSubscribeChannel() {
  const channel =
    await client.channels.fetch(
      config.discordSubscribeChannelId
    );

  if (
    !channel ||
    !channel.isTextBased()
  ) {
    throw new Error(
      "DISCORD_SUBSCRIBE_CHANNEL_ID ne correspond pas à un salon texte."
    );
  }

  /*
   * Nettoyage du salon.
   */
  await deleteAllMessages(channel);

  /*
   * Bannière.
   */
  const banner =
    new AttachmentBuilder(
      config.subscribeBannerPath
    );

  /*
   * Bouton Stripe.
   *
   * On utilise un bouton Discord et non une URL Stripe
   * fixe afin de pouvoir mettre le Discord user ID dans
   * les metadata du Checkout.
   */
  const subscribeButton =
    new ButtonBuilder()
      .setCustomId("subscribe")
      .setLabel("S'abonner")
      .setStyle(
        ButtonStyle.Primary
      );

  const row =
    new ActionRowBuilder<ButtonBuilder>()
      .addComponents(
        subscribeButton
      );

  await channel.send({
    files: [banner],
    components: [row]
  });

  console.log(
    "Subscription channel initialized."
  );
}

/*
 * ============================================================
 * MESSAGE CLEANER
 * ============================================================
 */

async function handleMessageCreate(
  message: Message
) {
  if (
    message.author.bot
  ) {
    return;
  }

  if (
    message.channel.id !==
    config.discordSubscribeChannelId
  ) {
    return;
  }

  try {
    await message.delete();
  } catch (error) {
    console.error(
      "Unable to delete subscription channel message:",
      error
    );
  }
}

/*
 * ============================================================
 * /abonnement
 * ============================================================
 */

async function handleSubscriptionCommand(
  interaction: ChatInputCommandInteraction
) {
  const url =
    await createCheckout(
      interaction.user.id
    );

  await interaction.reply({
    content:
      `Voici votre lien d'abonnement :\n${url}`,
    ephemeral: true
  });
}

/*
 * ============================================================
 * /statut
 * ============================================================
 */

async function handleStatusCommand(
  interaction: ChatInputCommandInteraction
) {
  const subscription =
    await getSubscription(
      interaction.user.id
    );

  if (!subscription) {
    await interaction.reply({
      content:
        "Aucun abonnement enregistré.",
      ephemeral: true
    });

    return;
  }

  const status =
    subscription.status;

  const active =
    status === "active" ||
    status === "trialing";

  await interaction.reply({
    content: [
      `Statut : **${status}**`,
      `Accès Jellyfin : **${
        active
          ? "ACTIF"
          : "INACTIF"
      }**`
    ].join("\n"),
    ephemeral: true
  });
}

/*
 * ============================================================
 * /compte
 * ============================================================
 */

async function handleAccountCommand(
  interaction: ChatInputCommandInteraction
) {
  const subscription =
    await getSubscription(
      interaction.user.id
    );

  if (!subscription) {
    await interaction.reply({
      content:
        "Vous n'avez aucun abonnement enregistré.",
      ephemeral: true
    });

    return;
  }

  const active =
    subscription.status === "active" ||
    subscription.status === "trialing";

  if (!active) {
    await interaction.reply({
      content: [
        "Votre abonnement n'est pas actif.",
        `Statut actuel : **${subscription.status}**`
      ].join("\n"),
      ephemeral: true
    });

    return;
  }

  if (
    !subscription.jellyfin_user_id
  ) {
    await interaction.reply({
      content:
        "Votre abonnement est actif, mais votre compte Jellyfin est encore en cours de configuration.",
      ephemeral: true
    });

    return;
  }

  const button =
    new ButtonBuilder()
      .setLabel(
        "Accéder à Jellyfin"
      )
      .setStyle(
        ButtonStyle.Link
      )
      .setURL(
        `${config.publicBaseUrl}/auth/discord`
      );

  const row =
    new ActionRowBuilder<ButtonBuilder>()
      .addComponents(
        button
      );

  await interaction.reply({
    content: [
      "Votre abonnement est **actif**.",
      "",
      "Cliquez sur le bouton ci-dessous pour vous authentifier avec Discord et accéder à Jellyfin."
    ].join("\n"),
    components: [row],
    ephemeral: true
  });
}

/*
 * ============================================================
 * BUTTONS
 * ============================================================
 */

async function handleButtonInteraction(
  interaction: ButtonInteraction
) {
  if (
    interaction.customId !==
    "subscribe"
  ) {
    return;
  }

  try {
    const url =
      await createCheckout(
        interaction.user.id
      );

    await interaction.reply({
      content:
        `Voici votre lien de paiement Stripe :\n${url}`,
      ephemeral: true
    });
  } catch (error) {
    console.error(
      "Stripe checkout error:",
      error
    );

    await interaction.reply({
      content:
        "Impossible de créer le lien d'abonnement. Réessayez dans quelques instants.",
      ephemeral: true
    });
  }
}

/*
 * ============================================================
 * INTERACTIONS
 * ============================================================
 */

export async function handleInteraction(
  interaction: Interaction
) {
  if (
    interaction.isButton()
  ) {
    await handleButtonInteraction(
      interaction
    );

    return;
  }

  if (
    !interaction.isChatInputCommand()
  ) {
    return;
  }

  try {
    switch (
      interaction.commandName
    ) {
      case "abonnement":
        await handleSubscriptionCommand(
          interaction
        );
        break;

      case "compte":
        await handleAccountCommand(
          interaction
        );
        break;

      case "statut":
        await handleStatusCommand(
          interaction
        );
        break;
    }
  } catch (error) {
    console.error(
      "Discord interaction error:",
      error
    );

    if (
      interaction.replied ||
      interaction.deferred
    ) {
      await interaction.followUp({
        content:
          "Une erreur est survenue.",
        ephemeral: true
      });
    } else {
      await interaction.reply({
        content:
          "Une erreur est survenue.",
        ephemeral: true
      });
    }
  }
}

/*
 * ============================================================
 * INITIALIZATION
 * ============================================================
 */

export async function initializeDiscord() {
  client.on(
    "interactionCreate",
    handleInteraction
  );

  client.on(
    "messageCreate",
    handleMessageCreate
  );

  await client.login(
    config.discordToken
  );

  await new Promise<void>(
    resolve => {
      if (client.isReady()) {
        resolve();
        return;
      }

      client.once(
        "ready",
        () => resolve()
      );
    }
  );

  console.log(
    `Discord connected as ${client.user?.tag}`
  );

  await registerCommands();

  await setupSubscribeChannel();
}