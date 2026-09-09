import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

export const config = {
  discordToken: required("DISCORD_TOKEN"),
  discordClientId: required("DISCORD_CLIENT_ID"),
  discordGuildId: required("DISCORD_GUILD_ID"),
  subscriberRoleId: required("DISCORD_SUBSCRIBER_ROLE_ID"),

  stripeSecretKey: required("STRIPE_SECRET_KEY"),
  stripeWebhookSecret: required("STRIPE_WEBHOOK_SECRET"),
  stripePriceId: required("STRIPE_PRICE_ID"),
  publicBaseUrl: required("PUBLIC_BASE_URL"),

  databaseUrl: required("DATABASE_URL"),

  jellyfinUrl: required("JELLYFIN_URL").replace(/\/+$/, ""),
  jellyfinApiKey: required("JELLYFIN_API_KEY"),
  jellyfinLibraryId: process.env.JELLYFIN_LIBRARY_ID || "",
  jellyfinUserPrefix: process.env.JELLYFIN_USER_PREFIX || "Discord",

  webPort: Number(process.env.WEB_PORT || 3000)
};
