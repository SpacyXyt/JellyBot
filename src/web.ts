import express from "express";
import { config } from "./config.js";
import { stripe, handleStripeEvent } from "./stripe.js";
import { getSubscription, setJellyfinUserId } from "./db.js";
import { ensureSubscriptionUser, disableSubscriptionUser } from "./jellyfin.js";
import { syncDiscordRole } from "./discord.js";

export function startWeb() {
  const app = express();

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/success", (_req, res) => {
    res.type("html").send("<h1>Abonnement activé</h1><p>Vous pouvez revenir sur Discord.</p>");
  });

  app.get("/cancel", (_req, res) => {
    res.type("html").send("<h1>Paiement annulé</h1>");
  });

  app.post("/webhooks/stripe", express.raw({ type: "application/json" }), async (req, res) => {
    try {
      const signature = req.headers["stripe-signature"];
      if (!signature || Array.isArray(signature)) {
        res.status(400).send("Missing Stripe signature");
        return;
      }

      const event = stripe.webhooks.constructEvent(
        req.body,
        signature,
        config.stripeWebhookSecret
      );

      await handleStripeEvent(event);

      const data: any = event.data.object;
      const discordUserId =
        data?.metadata?.discordUserId ??
        null;

      if (discordUserId) {
        const subscription = await getSubscription(discordUserId);
        const active = subscription?.status === "active" || subscription?.status === "trialing";

        await syncDiscordRole(discordUserId, active);

        if (active) {
          const user = await ensureSubscriptionUser(discordUserId);
          await setJellyfinUserId(discordUserId, user.Id);
        } else if (subscription?.jellyfin_user_id) {
          await disableSubscriptionUser(subscription.jellyfin_user_id);
        }
      }

      res.sendStatus(200);
    } catch (error) {
      console.error("Stripe webhook error:", error);
      res.status(400).send("Webhook error");
    }
  });

  app.listen(config.webPort, "0.0.0.0", () => {
    console.log(`HTTP server listening on :${config.webPort}`);
  });
}
