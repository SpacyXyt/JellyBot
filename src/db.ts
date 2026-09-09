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

  /*
   * ============================================================
   * PARRAINAGES
   * ============================================================
   */

  await db.query(`
    CREATE TABLE IF NOT EXISTS referrals (
      referred_user_id TEXT PRIMARY KEY,

      referrer_user_id TEXT NOT NULL,

      invite_code TEXT,

      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_referrals_referrer
    ON referrals(referrer_user_id)
  `);

  /*
   * ============================================================
   * COMMISSIONS
   * ============================================================
   */

  await db.query(`
    CREATE TABLE IF NOT EXISTS referral_commissions (
      id BIGSERIAL PRIMARY KEY,

      referrer_user_id TEXT NOT NULL,

      referred_user_id TEXT NOT NULL,

      stripe_event_id TEXT UNIQUE,

      stripe_invoice_id TEXT,

      amount_cents BIGINT NOT NULL,

      commission_cents BIGINT NOT NULL,

      currency TEXT NOT NULL DEFAULT 'eur',

      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_referral_commissions_referrer
    ON referral_commissions(referrer_user_id)
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_referral_commissions_referred
    ON referral_commissions(referred_user_id)
  `);
}

/*
 * ============================================================
 * SUBSCRIPTIONS
 * ============================================================
 */

export async function upsertSubscription(data: {
  discordUserId: string;
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  status: string;
  currentPeriodEnd?: Date | null;
  jellyfinUserId?: string | null;
}) {
  await db.query(
    `
    INSERT INTO subscriptions
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

      status =
        EXCLUDED.status,

      current_period_end =
        EXCLUDED.current_period_end,

      jellyfin_user_id =
        COALESCE(
          EXCLUDED.jellyfin_user_id,
          subscriptions.jellyfin_user_id
        ),

      updated_at =
        NOW()
    `,
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

export async function getSubscription(
  discordUserId: string
) {
  const result = await db.query(
    `
    SELECT *
    FROM subscriptions
    WHERE discord_user_id = $1
    `,
    [discordUserId]
  );

  return result.rows[0] ?? null;
}

export async function setJellyfinUserId(
  discordUserId: string,
  jellyfinUserId: string
) {
  await db.query(
    `
    UPDATE subscriptions
    SET
      jellyfin_user_id = $2,
      updated_at = NOW()
    WHERE discord_user_id = $1
    `,
    [
      discordUserId,
      jellyfinUserId
    ]
  );
}

/*
 * ============================================================
 * PARRAINAGES
 * ============================================================
 */

/**
 * Enregistre un parrainage.
 *
 * Un filleul ne peut avoir qu'un seul parrain.
 */
export async function createReferral(
  referredUserId: string,
  referrerUserId: string,
  inviteCode?: string | null
) {
  if (
    referredUserId ===
    referrerUserId
  ) {
    return false;
  }

  const result = await db.query(
    `
    INSERT INTO referrals
    (
      referred_user_id,
      referrer_user_id,
      invite_code
    )
    VALUES ($1,$2,$3)

    ON CONFLICT (referred_user_id)
    DO NOTHING

    RETURNING *
    `,
    [
      referredUserId,
      referrerUserId,
      inviteCode ?? null
    ]
  );

  return result.rowCount === 1;
}

/**
 * Récupère le parrain d'un filleul.
 */
export async function getReferralByReferredUser(
  referredUserId: string
) {
  const result = await db.query(
    `
    SELECT *
    FROM referrals
    WHERE referred_user_id = $1
    `,
    [referredUserId]
  );

  return result.rows[0] ?? null;
}

/**
 * Statistiques d'un parrain.
 */
export async function getReferralStats(
  referrerUserId: string
) {
  const result = await db.query(
    `
    SELECT
      COUNT(
        DISTINCT r.referred_user_id
      )::INTEGER AS referred_count,

      COALESCE(
        (
          SELECT SUM(
            rc2.amount_cents
          )
          FROM referral_commissions rc2
          WHERE rc2.referrer_user_id = $1
        ),
        0
      )::BIGINT AS revenue_cents,

      COALESCE(
        (
          SELECT SUM(
            rc3.commission_cents
          )
          FROM referral_commissions rc3
          WHERE rc3.referrer_user_id = $1
        ),
        0
      )::BIGINT AS commission_cents

    FROM referrals r

    WHERE r.referrer_user_id = $1
    `,
    [referrerUserId]
  );

  return {
    referredCount:
      Number(
        result.rows[0]?.referred_count ?? 0
      ),

    revenueCents:
      Number(
        result.rows[0]?.revenue_cents ?? 0
      ),

    commissionCents:
      Number(
        result.rows[0]?.commission_cents ?? 0
      )
  };
}

/**
 * Enregistre une commission.
 *
 * Le stripe_event_id est unique afin d'éviter les doublons
 * lorsque Stripe renvoie plusieurs fois le même webhook.
 */
export async function createReferralCommission(
  data: {
    referrerUserId: string;
    referredUserId: string;
    stripeEventId: string;
    stripeInvoiceId?: string | null;
    amountCents: number;
    commissionCents: number;
    currency: string;
  }
) {
  const result = await db.query(
    `
    INSERT INTO referral_commissions
    (
      referrer_user_id,
      referred_user_id,
      stripe_event_id,
      stripe_invoice_id,
      amount_cents,
      commission_cents,
      currency
    )
    VALUES
    ($1,$2,$3,$4,$5,$6,$7)

    ON CONFLICT (stripe_event_id)
    DO NOTHING

    RETURNING *
    `,
    [
      data.referrerUserId,
      data.referredUserId,
      data.stripeEventId,
      data.stripeInvoiceId ?? null,
      data.amountCents,
      data.commissionCents,
      data.currency
    ]
  );

  return result.rowCount === 1;
}