import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(
      `Missing environment variable: ${name}`
    );
  }

  return value;
}

export const config = {
  discordToken:
    required("DISCORD_TOKEN"),

  discordClientId:
    required("DISCORD_CLIENT_ID"),

  discordGuildId:
    required("DISCORD_GUILD_ID"),

  subscriberRoleId:
    required("DISCORD_SUBSCRIBER_ROLE_ID"),

  discordReferralChannelId:
    required("DISCORD_REFERRAL_CHANNEL_ID"),

  discordSubscribeChannelId:
    required(
      "DISCORD_SUBSCRIBE_CHANNEL_ID"
    ),

  subscribeBannerPath:
    required(
      "SUBSCRIBE_BANNER_PATH"
    ),

  stripeSecretKey:
    required("STRIPE_SECRET_KEY"),

  stripeWebhookSecret:
    required(
      "STRIPE_WEBHOOK_SECRET"
    ),

  stripePriceId:
    required("STRIPE_PRICE_ID"),

  publicBaseUrl:
    required("PUBLIC_BASE_URL"),

  databaseUrl:
    required("DATABASE_URL"),

  jellyfinUrl:
    required("JELLYFIN_URL"),

  jellyfinApiKey:
    required("JELLYFIN_API_KEY"),

  jellyfinLibraryId:
    process.env.JELLYFIN_LIBRARY_ID ||
    "",

  jellyfinUserPrefix:
    process.env.JELLYFIN_USER_PREFIX ||
    "sub",

  webPort:
    Number(
      process.env.WEB_PORT || "4500"
    ),

  /*
   * Discord OAuth
   */
  discordOAuthClientId:
    required(
      "DISCORD_OAUTH_CLIENT_ID"
    ),

  discordOAuthClientSecret:
    required(
      "DISCORD_OAUTH_CLIENT_SECRET"
    ),

  discordOAuthRedirectUri:
    required(
      "DISCORD_OAUTH_REDIRECT_URI"
    ),

  /*
   * Session JWT
   */
  sessionSecret:
    required("SESSION_SECRET"),

  /*
   * Jellyfin reverse proxy
   */
  jellyfinProxyPath:
    process.env.JELLYFIN_PROXY_PATH ||
    "",

  jellyfinProxyTarget:
    process.env.JELLYFIN_PROXY_TARGET ||
    "http://127.0.0.1:8096"
};