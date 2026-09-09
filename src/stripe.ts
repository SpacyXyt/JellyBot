import Stripe from "stripe";

import { config } from "./config.js";

import {
  getSubscription,
  upsertSubscription,
  getReferralByReferredUser,
  createReferralCommission
} from "./db.js";

import {
  ensureSubscriptionUser,
  disableSubscriptionUser
} from "./jellyfin.js";

import {
  syncDiscordRole,
  client
} from "./discord.js";

export const stripe =
  new Stripe(
    config.stripeSecretKey
  );

/*
 * ============================================================
 * TAUX PARRAINAGE
 * ============================================================
 */

const REFERRAL_RATE = 0.15;

/*
 * ============================================================
 * STRIPE CHECKOUT
 * ============================================================
 */

export async function createCheckout(
  discordUserId: string
) {
  const session =
    await stripe.checkout.sessions.create({
      mode: "subscription",

      line_items: [
        {
          price:
            config.stripePriceId,

          quantity: 1
        }
      ],

      success_url:
        `${config.publicBaseUrl}/success`,

      cancel_url:
        `${config.publicBaseUrl}/cancel`,

      metadata: {
        discordUserId
      },

      subscription_data: {
        metadata: {
          discordUserId
        }
      }
    });

  if (!session.url) {
    throw new Error(
      "Stripe n'a pas fourni d'URL de checkout."
    );
  }

  return session.url;
}

/*
 * ============================================================
 * COMMISSION PARRAINAGE
 * ============================================================
 */

async function processReferralCommission(
  data: {
    referredUserId: string;
    stripeEventId: string;
    stripeInvoiceId?: string | null;
    amountCents: number;
    currency: string;
  }
) {
  /*
   * Montant invalide ou gratuit.
   */
  if (
    data.amountCents <= 0
  ) {
    return;
  }

  /*
   * Recherche du parrain.
   */
  const referral =
    await getReferralByReferredUser(
      data.referredUserId
    );

  if (!referral) {
    console.log(
      `Aucun parrain pour ${data.referredUserId}.`
    );

    return;
  }

  /*
   * Protection supplémentaire contre l'auto-parrainage.
   */
  if (
    referral.referrer_user_id ===
    data.referredUserId
  ) {
    console.warn(
      `Auto-parrainage détecté pour ${data.referredUserId}.`
    );

    return;
  }

  /*
   * Calcul de 15 %.
   *
   * Math.round permet d'obtenir un nombre entier
   * de centimes.
   */
  const commissionCents =
    Math.round(
      data.amountCents *
      REFERRAL_RATE
    );

  if (
    commissionCents <= 0
  ) {
    return;
  }

  /*
   * Enregistrement.
   *
   * stripeEventId UNIQUE empêche un webhook Stripe
   * d'être comptabilisé deux fois.
   */
  const created =
    await createReferralCommission({
      referrerUserId:
        referral.referrer_user_id,

      referredUserId:
        data.referredUserId,

      stripeEventId:
        data.stripeEventId,

      stripeInvoiceId:
        data.stripeInvoiceId ?? null,

      amountCents:
        data.amountCents,

      commissionCents,

      currency:
        data.currency
    });

  if (!created) {
    console.log(
      `Commission déjà enregistrée pour Stripe event ${data.stripeEventId}.`
    );

    return;
  }

  /*
   * Notification Discord.
   */
  try {
    const channel =
      client.channels.cache.get(
        config.discordReferralChannelId
      );

    if (
      channel &&
      channel.isTextBased()
    ) {
      const formatMoney =
        (cents: number) =>
          new Intl.NumberFormat(
            "fr-FR",
            {
              style: "currency",
              currency:
                data.currency.toUpperCase()
            }
          ).format(
            cents / 100
          );

      await channel.send({
        content: [
          "💰 **Commission de parrainage**",
          "",
          `👤 Parrain : <@${referral.referrer_user_id}>`,
          `🆕 Filleul : <@${data.referredUserId}>`,
          "",
          `💳 Paiement : **${formatMoney(data.amountCents)}**`,
          `💎 Commission (15 %) : **${formatMoney(commissionCents)}**`
        ].join("\n")
      });
    }
  } catch (error) {
    console.error(
      "Unable to send referral commission message:",
      error
    );
  }

  console.log(
    [
      "Referral commission created:",
      `referrer=${referral.referrer_user_id}`,
      `referred=${data.referredUserId}`,
      `amount=${data.amountCents}`,
      `commission=${commissionCents}`
    ].join(" ")
  );
}

/*
 * ============================================================
 * STRIPE WEBHOOK
 * ============================================================
 */

export async function handleStripeEvent(
  event: Stripe.Event
) {
  /*
   * ==========================================================
   * CHECKOUT TERMINÉ
   * ==========================================================
   */

  if (
    event.type ===
    "checkout.session.completed"
  ) {
    const session =
      event.data.object as Stripe.Checkout.Session;

    const discordUserId =
      session.metadata?.discordUserId;

    if (!discordUserId) {
      console.error(
        "Checkout sans discordUserId:",
        session.id
      );

      return;
    }

    const subscriptionId =
      typeof session.subscription ===
      "string"
        ? session.subscription
        : session.subscription?.id ??
          null;

    const customerId =
      typeof session.customer ===
      "string"
        ? session.customer
        : session.customer?.id ??
          null;

    console.log(
      `Paiement reçu pour Discord ${discordUserId}`
    );

    /*
     * ----------------------------------------------------------
     * Création / récupération Jellyfin
     * ----------------------------------------------------------
     */

    const jellyfinUser =
      await ensureSubscriptionUser(
        discordUserId
      );

    console.log(
      `Compte Jellyfin prêt : ${jellyfinUser.user.Name}`
    );

    /*
     * ----------------------------------------------------------
     * Sauvegarde DB
     * ----------------------------------------------------------
     */

    await upsertSubscription({
      discordUserId,

      stripeCustomerId:
        customerId,

      stripeSubscriptionId:
        subscriptionId,

      status:
        "active",

      jellyfinUserId:
        jellyfinUser.user.Id
    });

    /*
     * ----------------------------------------------------------
     * Ajout rôle Discord
     * ----------------------------------------------------------
     */

    await syncDiscordRole(
      discordUserId,
      true
    );

    /*
     * ----------------------------------------------------------
     * Commission sur le premier paiement
     * ----------------------------------------------------------
     *
     * checkout.session.completed est utilisé ici pour
     * créditer le premier paiement.
     */

    const paymentAmount =
      session.amount_total;

    if (
      typeof paymentAmount ===
        "number" &&
      paymentAmount > 0
    ) {
      await processReferralCommission({
        referredUserId:
          discordUserId,

        stripeEventId:
          event.id,

        stripeInvoiceId:
          typeof session.invoice ===
          "string"
            ? session.invoice
            : session.invoice?.id ??
              null,

        amountCents:
          paymentAmount,

        currency:
          session.currency ??
          "eur"
      });
    }

    console.log(
      `Abonnement activé pour ${discordUserId}`
    );

    return;
  }

  /*
   * ==========================================================
   * PAIEMENT D'UN RENOUVELLEMENT
   * ==========================================================
   *
   * Stripe envoie invoice.payment_succeeded lors des
   * renouvellements.
   */

  if (
    event.type ===
    "invoice.payment_succeeded"
  ) {
    const invoice =
      event.data.object as Stripe.Invoice;

    /*
     * On récupère l'abonnement.
     */
    const subscriptionId =
      typeof invoice.subscription ===
      "string"
        ? invoice.subscription
        : invoice.subscription?.id ??
          null;

    if (!subscriptionId) {
      return;
    }

    /*
     * Récupération de l'abonnement Stripe afin de retrouver
     * les metadata Discord.
     */
    let subscription:
      Stripe.Subscription;

    try {
      subscription =
        await stripe.subscriptions.retrieve(
          subscriptionId
        );
    } catch (error) {
      console.error(
        `Impossible de récupérer la subscription ${subscriptionId}:`,
        error
      );

      return;
    }

    const discordUserId =
      subscription.metadata?.discordUserId;

    if (!discordUserId) {
      console.warn(
        `Subscription ${subscriptionId} sans discordUserId`
      );

      return;
    }

    /*
     * Évite de compter deux fois le premier paiement.
     *
     * Le premier paiement est déjà traité par
     * checkout.session.completed.
     *
     * Les factures suivantes sont des renouvellements.
     *
     * Stripe fournit invoice.billing_reason.
     */
    if (
      invoice.billing_reason ===
      "subscription_create"
    ) {
      return;
    }

    /*
     * Montant effectivement payé.
     *
     * amount_paid est préféré à amount_due car la commission
     * doit être basée sur le paiement réellement encaissé.
     */
    const amountPaid =
      invoice.amount_paid;

    if (
      typeof amountPaid !==
        "number" ||
      amountPaid <= 0
    ) {
      return;
    }

    await processReferralCommission({
      referredUserId:
        discordUserId,

      stripeEventId:
        event.id,

      stripeInvoiceId:
        invoice.id,

      amountCents:
        amountPaid,

      currency:
        invoice.currency ??
        "eur"
    });

    return;
  }

  /*
   * ==========================================================
   * ABONNEMENT CRÉÉ / MODIFIÉ / SUPPRIMÉ
   * ==========================================================
   */

  if (
    event.type ===
      "customer.subscription.created" ||
    event.type ===
      "customer.subscription.updated" ||
    event.type ===
      "customer.subscription.deleted"
  ) {
    const subscription =
      event.data.object as Stripe.Subscription;

    const discordUserId =
      subscription.metadata?.discordUserId;

    if (!discordUserId) {
      console.warn(
        `Subscription ${subscription.id} sans discordUserId`
      );

      return;
    }

    /*
     * ----------------------------------------------------------
     * Statut
     * ----------------------------------------------------------
     */

    const active =
      subscription.status ===
        "active" ||
      subscription.status ===
        "trialing";

    /*
     * ----------------------------------------------------------
     * Date de fin de période
     * ----------------------------------------------------------
     */

    const currentPeriodEnd =
      "current_period_end" in
        subscription &&
      subscription.current_period_end
        ? new Date(
            Number(
              subscription.current_period_end
            ) * 1000
          )
        : null;

    /*
     * ----------------------------------------------------------
     * Customer Stripe
     * ----------------------------------------------------------
     */

    const customerId =
      typeof subscription.customer ===
      "string"
        ? subscription.customer
        : subscription.customer?.id ??
          null;

    /*
     * ==========================================================
     * ABONNEMENT ACTIF
     * ==========================================================
     */

    if (active) {
      const jellyfinUser =
        await ensureSubscriptionUser(
          discordUserId
        );

      await upsertSubscription({
        discordUserId,

        stripeCustomerId:
          customerId,

        stripeSubscriptionId:
          subscription.id,

        status:
          subscription.status,

        currentPeriodEnd,

        jellyfinUserId:
          jellyfinUser.user.Id
      });

      await syncDiscordRole(
        discordUserId,
        true
      );

      console.log(
        `Accès Jellyfin activé : ${discordUserId}`
      );

      return;
    }

    /*
     * ==========================================================
     * ABONNEMENT INACTIF
     * ==========================================================
     */

    const existing =
      await getSubscription(
        discordUserId
      );

    /*
     * Désactivation Jellyfin.
     */
    if (
      existing?.jellyfin_user_id
    ) {
      await disableSubscriptionUser(
        existing.jellyfin_user_id
      );

      console.log(
        `Compte Jellyfin désactivé : ${existing.jellyfin_user_id}`
      );
    }

    /*
     * Mise à jour DB.
     */
    await upsertSubscription({
      discordUserId,

      stripeCustomerId:
        customerId,

      stripeSubscriptionId:
        subscription.id,

      status:
        subscription.status,

      currentPeriodEnd,

      jellyfinUserId:
        existing?.jellyfin_user_id ??
        null
    });

    /*
     * Retrait rôle Discord.
     */
    await syncDiscordRole(
      discordUserId,
      false
    );

    console.log(
      `Accès retiré pour ${discordUserId}`
    );
  }
}