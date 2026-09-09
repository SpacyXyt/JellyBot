import Stripe from "stripe";
import { config } from "./config.js";
import {
  getSubscription,
  upsertSubscription
} from "./db.js";

import {
  ensureSubscriptionUser,
  disableSubscriptionUser
} from "./jellyfin.js";

import {
  syncDiscordRole
} from "./discord.js";


export const stripe = new Stripe(
  config.stripeSecretKey
);


// ============================================================
// STRIPE CHECKOUT
// ============================================================

export async function createCheckout(
  discordUserId: string
) {
  const session =
    await stripe.checkout.sessions.create({
      mode: "subscription",

      line_items: [
        {
          price: config.stripePriceId,
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


// ============================================================
// STRIPE WEBHOOK
// ============================================================

export async function handleStripeEvent(
  event: Stripe.Event
) {

  // ==========================================================
  // CHECKOUT TERMINÉ
  // ==========================================================

  if (
    event.type === "checkout.session.completed"
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
      typeof session.subscription === "string"
        ? session.subscription
        : session.subscription?.id ?? null;


    const customerId =
      typeof session.customer === "string"
        ? session.customer
        : session.customer?.id ?? null;


    console.log(
      `Paiement reçu pour Discord ${discordUserId}`
    );


    // ----------------------------------------------------------
    // Création / récupération du compte Jellyfin
    // ----------------------------------------------------------

    const jellyfinUser =
      await ensureSubscriptionUser(
        discordUserId
      );


    console.log(
      `Compte Jellyfin prêt : ${jellyfinUser.Name}`
    );


    // ----------------------------------------------------------
    // Sauvegarde DB
    // ----------------------------------------------------------

    await upsertSubscription({
      discordUserId,

      stripeCustomerId:
        customerId,

      stripeSubscriptionId:
        subscriptionId,

      status:
        "active",

      jellyfinUserId:
        jellyfinUser.Id
    });


    // ----------------------------------------------------------
    // Ajout du rôle Discord
    // ----------------------------------------------------------

    await syncDiscordRole(
      discordUserId,
      true
    );


    console.log(
      `Abonnement activé pour ${discordUserId}`
    );


    return;
  }


  // ==========================================================
  // ABONNEMENT CRÉÉ / MODIFIÉ / SUPPRIMÉ
  // ==========================================================

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


    // ----------------------------------------------------------
    // Statut
    // ----------------------------------------------------------

    const active =
      subscription.status === "active" ||
      subscription.status === "trialing";


    // ----------------------------------------------------------
    // Date de fin de période
    // ----------------------------------------------------------

    const currentPeriodEnd =
      "current_period_end" in subscription &&
      subscription.current_period_end

        ? new Date(
            Number(
              subscription.current_period_end
            ) * 1000
          )

        : null;


    // ----------------------------------------------------------
    // Customer Stripe
    // ----------------------------------------------------------

    const customerId =
      typeof subscription.customer === "string"
        ? subscription.customer
        : subscription.customer?.id ?? null;


    // ==========================================================
    // ABONNEMENT ACTIF
    // ==========================================================

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
          jellyfinUser.Id
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


    // ==========================================================
    // ABONNEMENT INACTIF
    // ==========================================================

    const existing =
      await getSubscription(
        discordUserId
      );


    // ----------------------------------------------------------
    // Désactivation Jellyfin
    // ----------------------------------------------------------

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


    // ----------------------------------------------------------
    // Mise à jour DB
    // ----------------------------------------------------------

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
        existing?.jellyfin_user_id ?? null
    });


    // ----------------------------------------------------------
    // Retrait du rôle Discord
    // ----------------------------------------------------------

    await syncDiscordRole(
      discordUserId,
      false
    );


    console.log(
      `Accès retiré pour ${discordUserId}`
    );
  }
}