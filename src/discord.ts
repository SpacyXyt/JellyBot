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
  type Message,
  TextChannel,
  type Guild,
  type Invite
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
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildInvites
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
    await interaction.reply({
      content:
        "Cette commande doit être utilisée dans le serveur Discord.",
      ephemeral: true
    });

    return;
  }

  const member =
    interaction.member as import("discord.js").GuildMember;

  const hasSubscriberRole =
    member.roles.cache.has(
      config.subscriberRoleId
    );

  if (
    !hasSubscriberRole
  ) {
    await interaction.reply({
      content: [
        "❌ Vous ne pouvez pas créer d'invitation de parrainage.",
        "",
        `Vous devez posséder le rôle <@&${config.subscriberRoleId}>.`
      ].join("\n"),
      ephemeral: true
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
      await interaction.reply({
        content:
          "Le salon de parrainage n'est pas correctement configuré.",
        ephemeral: true
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

    await interaction.reply({
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
      ephemeral: true
    });
  } catch (error) {
    console.error(
      "Referral invite creation error:",
      error
    );

    await interaction.reply({
      content: [
        "❌ Impossible de créer votre invitation.",
        "",
        "Vérifiez que le bot possède la permission **Créer une invitation** dans le salon de parrainage."
      ].join("\n"),
      ephemeral: true
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

      case "parrainage":
        await handleReferralCommand(
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

  client.on(
    "guildMemberAdd",
    handleGuildMemberAdd
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