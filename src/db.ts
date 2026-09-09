import { Pool } from "pg";
import { config } from "./config.js";

export const db = new Pool({
  connectionString: config.databaseUrl
});

export async function initDb() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      discord_user_id TEXT PRIMARY KEY,
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT UNIQUE,
      status TEXT NOT NULL DEFAULT 'inactive',
      current_period_end TIMESTAMPTZ,
      jellyfin_user_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

export async function upsertSubscription(data: {
  discordUserId: string;
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  status: string;
  currentPeriodEnd?: Date | null;
  jellyfinUserId?: string | null;
}) {
  await db.query(
    `INSERT INTO subscriptions
      (
        discord_user_id,
        stripe_customer_id,
        stripe_subscription_id,
        status,
        current_period_end,
        jellyfin_user_id,
        updated_at
      )
     VALUES ($1,$2,$3,$4,$5,$6,NOW())

     ON CONFLICT (discord_user_id) DO UPDATE SET
       stripe_customer_id =
         COALESCE(
           EXCLUDED.stripe_customer_id,
           subscriptions.stripe_customer_id
         ),

       stripe_subscription_id =
         COALESCE(
           EXCLUDED.stripe_subscription_id,
           subscriptions.stripe_subscription_id
         ),

       status = EXCLUDED.status,

       current_period_end = EXCLUDED.current_period_end,

       jellyfin_user_id =
         COALESCE(
           EXCLUDED.jellyfin_user_id,
           subscriptions.jellyfin_user_id
         ),

       updated_at = NOW()`,
    [
      data.discordUserId,
      data.stripeCustomerId ?? null,
      data.stripeSubscriptionId ?? null,
      data.status,
      data.currentPeriodEnd ?? null,
      data.jellyfinUserId ?? null
    ]
  );
}

export async function getSubscription(discordUserId: string) {
  const result = await db.query(
    `SELECT *
     FROM subscriptions
     WHERE discord_user_id = $1`,
    [discordUserId]
  );

  return result.rows[0] ?? null;
}

export async function setJellyfinUserId(
  discordUserId: string,
  jellyfinUserId: string
) {
  await db.query(
    `UPDATE subscriptions
     SET jellyfin_user_id = $2,
         updated_at = NOW()
     WHERE discord_user_id = $1`,
    [discordUserId, jellyfinUserId]
  );
}