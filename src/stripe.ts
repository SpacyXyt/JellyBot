import Stripe from "stripe";
import { config } from "./config.js";
import { upsertSubscription } from "./db.js";

export const stripe = new Stripe(config.stripeSecretKey);

export async function createCheckout(discordUserId: string) {
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: config.stripePriceId, quantity: 1 }],
    success_url: `${config.publicBaseUrl}/success`,
    cancel_url: `${config.publicBaseUrl}/cancel`,
    metadata: { discordUserId },
    subscription_data: {
      metadata: { discordUserId }
    }
  });

  if (!session.url) throw new Error("Stripe n'a pas fourni d'URL de checkout.");
  return session.url;
}

export async function handleStripeEvent(event: Stripe.Event) {
  if (
    event.type === "customer.subscription.created" ||
    event.type === "customer.subscription.updated" ||
    event.type === "customer.subscription.deleted"
  ) {
    const subscription = event.data.object as Stripe.Subscription;
    const discordUserId = subscription.metadata.discordUserId;

    if (!discordUserId) return;

    const currentPeriodEnd =
      "current_period_end" in subscription && subscription.current_period_end
        ? new Date(Number(subscription.current_period_end) * 1000)
        : null;

    await upsertSubscription({
      discordUserId,
      stripeCustomerId: typeof subscription.customer === "string"
        ? subscription.customer
        : subscription.customer?.id ?? null,
      stripeSubscriptionId: subscription.id,
      status: subscription.status,
      currentPeriodEnd
    });
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;
    const discordUserId = session.metadata?.discordUserId;
    if (!discordUserId) return;

    const subscriptionId =
      typeof session.subscription === "string"
        ? session.subscription
        : session.subscription?.id ?? null;

    await upsertSubscription({
      discordUserId,
      stripeCustomerId:
        typeof session.customer === "string"
          ? session.customer
          : session.customer?.id ?? null,
      stripeSubscriptionId: subscriptionId,
      status: "active"
    });
  }
}
