import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  GatewayIntentBits,
  Events,
  MessageFlags,
  REST,
  Routes,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type ButtonInteraction,
  type Interaction,
  type Message,
  TextChannel,
  type Guild
} from "discord.js";

import { config } from "./config.js";

import {
  createCheckout
} from "./stripe.js";

import {
  getSubscription,
  createReferral,
  getReferralStats
} from "./db.js";

export const client =
  new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMembers
    ]
  });

/*
 * ============================================================
 * INVITATIONS EN MÉMOIRE
 * ============================================================
 *
 * invite code -> Discord user ID du parrain
 */

const referralInvites =
  new Map<
    string,
    {
      guildId: string;
      referrerUserId: string;
      uses: number;
    }
  >();

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
    ),

  new SlashCommandBuilder()
    .setName("parrainage")
    .setDescription(
      "Créer votre invitation et voir vos statistiques de parrainage"
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
  let before:
    string | undefined;

  while (true) {
    const messages =
      await channel.messages.fetch({
        limit: 100,
        ...(before
          ? { before }
          : {})
      });

    if (
      messages.size === 0
    ) {
      break;
    }

    for (
      const message of messages.values()
    ) {
      try {
        await message.delete();
      } catch {
        // Message déjà supprimé / trop ancien.
      }
    }

    const last =
      messages.last();

    if (!last) {
      break;
    }

    before = last.id;

    if (
      messages.size < 100
    ) {
      break;
    }
  }
}

export async function setupSubscribeChannel() {
  const channel =
    client.channels.cache.get(
      config.discordSubscribeChannelId
    ) as TextChannel;

  if (
    !channel ||
    !channel.isTextBased()
  ) {
    throw new Error(
      "DISCORD_SUBSCRIBE_CHANNEL_ID ne correspond pas à un salon texte."
    );
  }

  await deleteAllMessages(
    channel
  );

  const banner =
    new AttachmentBuilder(
      config.subscribeBannerPath
    );

  const subscribeButton =
    new ButtonBuilder()
      .setCustomId(
        "subscribe"
      )
      .setLabel(
        "S'abonner"
      )
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
 * REFERRAL CHANNEL
 * ============================================================
 */

async function sendReferralMessage(
  content: string
) {
  try {
    const channel =
      client.channels.cache.get(
        config.discordReferralChannelId
      ) as TextChannel;

    if (
      !channel ||
      !channel.isTextBased()
    ) {
      console.error(
        "DISCORD_REFERRAL_CHANNEL_ID ne correspond pas à un salon texte."
      );

      return;
    }

    await channel.send({
      content
    });
  } catch (error) {
    console.error(
      "Referral channel error:",
      error
    );
  }
}

/*
 * ============================================================
 * INITIALISATION DES INVITATIONS
 * ============================================================
 */

async function cacheGuildInvites(
  guild: Guild
) {
  try {
    const invites =
      await guild.invites.fetch();

    for (
      const invite of invites.values()
    ) {
      const existing =
        referralInvites.get(
          invite.code
        );

      if (existing) {
        existing.uses =
          invite.uses ?? 0;

        continue;
      }

      /*
       * Les invitations déjà présentes avant le lancement
       * du système ne sont pas considérées comme des invitations
       * de parrainage.
       */
      referralInvites.set(
        invite.code,
        {
          guildId: guild.id,
          referrerUserId:
            invite.inviter?.id ?? "",
          uses:
            invite.uses ?? 0
        }
      );
    }

    console.log(
      `Invitations synchronisées pour ${guild.name}.`
    );
  } catch (error) {
    console.error(
      `Impossible de récupérer les invitations de ${guild.name}:`,
      error
    );
  }
}

/*
 * ============================================================
 * DÉTECTION DU PARRAIN
 * ============================================================
 */

async function detectUsedReferralInvite(
  guild: Guild
) {
  try {
    const invites =
      await guild.invites.fetch();

    for (
      const invite of invites.values()
    ) {
      const cached =
        referralInvites.get(
          invite.code
        );

      /*
       * Invitation créée par notre commande /parrainage.
       */
      if (
        !cached ||
        !cached.referrerUserId
      ) {
        continue;
      }

      const previousUses =
        cached.uses;

      const currentUses =
        invite.uses ?? 0;

      if (
        currentUses >
        previousUses
      ) {
        cached.uses =
          currentUses;

        return {
          invite,
          referrerUserId:
            cached.referrerUserId
        };
      }

      cached.uses =
        currentUses;
    }
  } catch (error) {
    console.error(
      "Referral invite detection error:",
      error
    );
  }

  return null;
}

/*
 * ============================================================
 * GUILD MEMBER ADD
 * ============================================================
 */

async function handleGuildMemberAdd(
  member: import("discord.js").GuildMember
) {
  if (
    member.guild.id !==
    config.discordGuildId
  ) {
    return;
  }

  const result =
    await detectUsedReferralInvite(
      member.guild
    );

  if (!result) {
    console.log(
      `Aucun parrain détecté pour ${member.user.tag}.`
    );

    return;
  }

  const {
    invite,
    referrerUserId
  } = result;

  /*
   * Protection contre l'auto-parrainage.
   */
  if (
    referrerUserId ===
    member.id
  ) {
    return;
  }

  const created =
    await createReferral(
      member.id,
      referrerUserId,
      invite.code
    );

  if (!created) {
    return;
  }

  console.log(
    `Parrainage enregistré : ${referrerUserId} -> ${member.id}`
  );

  await sendReferralMessage(
    [
      "🎉 **Nouveau parrainage**",
      "",
      `👤 Parrain : <@${referrerUserId}>`,
      `🆕 Nouveau membre : <@${member.id}>`,
      `🔗 Invitation : \`${invite.code}\``,
      "",
      "💰 La commission de 15 % sera créditée lorsqu'un paiement Stripe sera confirmé."
    ].join("\n")
  );
}

/*
 * ============================================================
 * /PARRAINAGE
 * ============================================================
 */

async function handleReferralCommand(
  interaction: ChatInputCommandInteraction
) {
  /*
   * Le membre doit avoir le rôle Subscribed.
   */

  if (
    !interaction.inGuild()
  ) {
    await interaction.editReply({
      content:
        "Cette commande doit être utilisée dans le serveur Discord.",
    });

    return;
  }

  const guild = await client.guilds.fetch(interaction.guildId);
  const member = await guild.members.fetch(interaction.user.id);

  const hasSubscriberRole =
    member.roles.cache.has(
      config.subscriberRoleId
    );

  if (
    !hasSubscriberRole
  ) {
    await interaction.editReply({
      content: [
        "❌ Vous ne pouvez pas créer d'invitation de parrainage.",
        "",
        `Vous devez posséder le rôle <@&${config.subscriberRoleId}>.`
      ].join("\n"),
    });

    return;
  }

  try {
    /*
     * On utilise le salon de parrainage comme salon cible
     * si possible.
     */
    const referralChannel =
      client.channels.cache.get(
        config.discordReferralChannelId
      ) as TextChannel;

    if (
      !referralChannel ||
      !referralChannel.isTextBased()
    ) {
      await interaction.editReply({
        content:
          "Le salon de parrainage n'est pas correctement configuré.",
      });

      return;
    }

    /*
     * Invitation sans expiration et sans limite d'utilisation.
     *
     * C'est le bot qui crée techniquement l'invitation,
     * mais elle est enregistrée comme appartenant au membre
     * qui a exécuté /parrainage.
     */
    const invite =
      await referralChannel.createInvite({
        maxAge: 0,
        maxUses: 0,
        unique: true,
        reason:
          `Invitation de parrainage créée pour ${interaction.user.tag} (${interaction.user.id})`
      });

    /*
     * Enregistrement local.
     */
    referralInvites.set(
      invite.code,
      {
        guildId:
          interaction.guildId,
        referrerUserId:
          interaction.user.id,
        uses:
          invite.uses ?? 0
      }
    );

    /*
     * Statistiques actuelles.
     */
    const stats =
      await getReferralStats(
        interaction.user.id
      );

    const inviteUrl =
      `https://discord.gg/${invite.code}`;

    await interaction.editReply({
      content: [
        "🎁 **Votre invitation de parrainage**",
        "",
        `🔗 ${inviteUrl}`,
        "",
        "Partagez cette invitation pour inviter quelqu'un sur le serveur.",
        "",
        "📊 **Vos statistiques**",
        `👥 Filleuls : **${stats.referredCount}**`,
        `💰 Revenus générés : **${formatMoney(stats.revenueCents)}**`,
        `💎 Commissions : **${formatMoney(stats.commissionCents)}**`,
        "",
        "Vous recevez **15 %** des paiements Stripe générés par vos filleuls."
      ].join("\n"),
    });
  } catch (error) {
    console.error(
      "Referral invite creation error:",
      error
    );

    await interaction.editReply({
      content: [
        "❌ Impossible de créer votre invitation.",
        "",
        "Vérifiez que le bot possède la permission **Créer une invitation** dans le salon de parrainage."
      ].join("\n"),
    });
  }
}

/*
 * ============================================================
 * FORMAT MONEY
 * ============================================================
 */

function formatMoney(
  cents: number,
  currency = "EUR"
) {
  return new Intl.NumberFormat(
    "fr-FR",
    {
      style: "currency",
      currency
    }
  ).format(
    cents / 100
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
 * /ABONNEMENT
 * ============================================================
 */

async function handleSubscriptionCommand(
  interaction: ChatInputCommandInteraction
) {
  try {
    const url = await createCheckout(
      interaction.user.id
    );

    await interaction.editReply({
      content:
        `Voici votre lien d'abonnement :\n${url}`
    });

  } catch (error) {
    console.error(
      "Stripe checkout error:",
      error
    );

    if (interaction.deferred) {
      await interaction.editReply({
        content:
          "Impossible de créer le lien d'abonnement. Réessayez dans quelques instants."
      });
    }
  }
}

/*
 * ============================================================
 * /STATUT
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
    await interaction.editReply({
      content:
        "Aucun abonnement enregistré.",
    });

    return;
  }

  const status =
    subscription.status;

  const active =
    status === "active" ||
    status === "trialing";

  await interaction.editReply({
    content: [
      `Statut : **${status}**`,
      `Accès Jellyfin : **${
        active
          ? "ACTIF"
          : "INACTIF"
      }**`
    ].join("\n"),
  });
}

/*
 * ============================================================
 * /COMPTE
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
    await interaction.editReply({
      content:
        "Vous n'avez aucun abonnement enregistré.",
    });

    return;
  }

  const active =
    subscription.status === "active" ||
    subscription.status === "trialing";

  if (!active) {
    await interaction.editReply({
      content: [
        "Votre abonnement n'est pas actif.",
        `Statut actuel : **${subscription.status}**`
      ].join("\n"),
    });

    return;
  }

  if (
    !subscription.jellyfin_user_id
  ) {
    await interaction.editReply({
      content:
        "Votre abonnement est actif, mais votre compte Jellyfin est encore en cours de configuration.",
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

  await interaction.editReply({
    content: [
      "Votre abonnement est **actif**.",
      "",
      "Cliquez sur le bouton ci-dessous pour vous authentifier avec Discord et accéder à Jellyfin."
    ].join("\n"),
    components: [row],
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
  if (interaction.customId !== "subscribe") {
    return;
  }

  try {
    // Réponse immédiate à Discord
    // Création du checkout après avoir acquitté l'interaction
    const url = await createCheckout(
      interaction.user.id
    );

    await interaction.editReply({
      content:
        `Voici votre lien de paiement Stripe :\n${url}`
    });

  } catch (error) {
    console.error(
      "Stripe checkout error:",
      error
    );

    // L'interaction a déjà été deferReply()
    // donc on utilise editReply(), pas reply()
    if (interaction.deferred) {
      await interaction.editReply({
        content:
          "Impossible de créer le lien d'abonnement. Réessayez dans quelques instants."
      });
    }
  }
}

/*
 * ============================================================
 * INTERACTIONS
 * ============================================================
 */

// Avoid processing the same gateway object twice if a caller accidentally
// dispatches it again while the initial acknowledgement is still pending.
const handledInteractions = new WeakSet<Interaction>();

export async function handleInteraction(interaction: Interaction) {
  const supported = interaction.isButton()
    ? interaction.customId === "subscribe"
    : interaction.isChatInputCommand() &&
      ["abonnement", "compte", "statut", "parrainage"].includes(interaction.commandName);

  if (!supported || handledInteractions.has(interaction)) return;
  if (!interaction.isButton() && !interaction.isChatInputCommand()) return;
  handledInteractions.add(interaction);

  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  } catch (error) {
    // An expired or already acknowledged interaction cannot be acknowledged again.
    const code = (error as { code?: string | number }).code;
    console.error("Discord acknowledgement failed:", { interactionId: interaction.id, code });
    return;
  }

  try {
    if (interaction.isButton()) {
      await handleButtonInteraction(interaction);
      return;
    }

    switch (interaction.commandName) {
      case "abonnement":
        await handleSubscriptionCommand(interaction);
        break;
      case "compte":
        await handleAccountCommand(interaction);
        break;
      case "statut":
        await handleStatusCommand(interaction);
        break;
      case "parrainage":
        await handleReferralCommand(interaction);
        break;
    }
  } catch (error) {
    console.error("Discord interaction error:", error);
    await interaction.editReply({ content: "Une erreur est survenue." })
      .catch(() => undefined);
  }
}

/*
 * ============================================================
 * INITIALIZATION
 * ============================================================
 */

export async function initializeDiscord() {
  client.on(
    Events.InteractionCreate,
    handleInteraction
  );

  client.on(
    Events.MessageCreate,
    message => { void handleMessageCreate(message).catch(console.error); }
  );

  client.on(
    Events.GuildMemberAdd,
    member => { void handleGuildMemberAdd(member).catch(console.error); }
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
        Events.ClientReady,
        () => resolve()
      );
    }
  );

  console.log(
    `Discord connected as ${client.user?.tag}`
  );

  /*
   * Synchronisation des invitations
   * au démarrage.
   */
  const guild =
    await client.guilds.fetch(
      config.discordGuildId
    );

  await cacheGuildInvites(
    guild
  );

  await registerCommands();

  await setupSubscribeChannel();
}