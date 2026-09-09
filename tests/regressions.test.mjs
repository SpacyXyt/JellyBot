import assert from "node:assert/strict";
import { test } from "node:test";

// Keep tests isolated from local credentials and production services.
for (const key of [
  "DISCORD_TOKEN", "DISCORD_CLIENT_ID", "DISCORD_GUILD_ID",
  "DISCORD_SUBSCRIBER_ROLE_ID", "DISCORD_REFERRAL_CHANNEL_ID",
  "DISCORD_SUBSCRIBE_CHANNEL_ID", "SUBSCRIBE_BANNER_PATH",
  "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PRICE_ID",
  "PUBLIC_BASE_URL", "DATABASE_URL", "JELLYFIN_URL", "JELLYFIN_API_KEY",
  "DISCORD_OAUTH_CLIENT_ID", "DISCORD_OAUTH_CLIENT_SECRET",
  "DISCORD_OAUTH_REDIRECT_URI", "SESSION_SECRET"
]) process.env[key] = "test";
process.env.JELLYFIN_USER_PREFIX = "sub";
process.env.DOTENV_CONFIG_QUIET = "true";

const { handleInteraction } = await import("../src/discord.ts");
const { createOrGetJellyfinUser } = await import("../src/jellyfin.ts");

function referralInteraction() {
  const calls = [];
  return {
    calls,
    id: "test-interaction",
    commandName: "parrainage",
    isButton: () => false,
    isChatInputCommand: () => true,
    inGuild: () => false,
    async deferReply(options) { calls.push(["defer", options]); },
    async editReply(options) { calls.push(["edit", options]); }
  };
}

test("acknowledges privately before replying to a referral command", async () => {
  const interaction = referralInteraction();
  await handleInteraction(interaction);
  assert.deepEqual(interaction.calls.map(([name]) => name), ["defer", "edit"]);
  assert.equal(interaction.calls[0][1].flags, 64);
});

test("concurrent duplicate dispatch only acknowledges and handles once", async () => {
  const interaction = referralInteraction();
  await Promise.all([handleInteraction(interaction), handleInteraction(interaction)]);
  assert.deepEqual(interaction.calls.map(([name]) => name), ["defer", "edit"]);
});

test("expired acknowledgement stops without a second reply", async (t) => {
  t.mock.method(console, "error", () => {});
  const interaction = referralInteraction();
  interaction.deferReply = async () => { throw Object.assign(new Error("expired"), { code: 10062 }); };
  await handleInteraction(interaction);
  assert.equal(interaction.calls.length, 0);
});

test("unsupported buttons are left untouched", async () => {
  const interaction = referralInteraction();
  interaction.isButton = () => true;
  interaction.customId = "unrelated";
  await handleInteraction(interaction);
  assert.equal(interaction.calls.length, 0);
});

test("concurrent Jellyfin creation sends a single POST", async (t) => {
  let posts = 0;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    if (options.method === "POST") {
      posts++;
      return Response.json({ Id: "jf-1", Name: "sub-1" });
    }
    return Response.json([]);
  });
  const users = await Promise.all([createOrGetJellyfinUser("1"), createOrGetJellyfinUser("1")]);
  assert.equal(posts, 1);
  assert.deepEqual(users[0], users[1]);
});

test("recovers an account created before Jellyfin returned 500", async (t) => {
  let reads = 0;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    if (options.method === "POST") return new Response("creation failed", { status: 500 });
    return Response.json(++reads === 1 ? [] : [{ Id: "jf-2", Name: "sub-2" }]);
  });
  assert.equal((await createOrGetJellyfinUser("2")).Id, "jf-2");
});

test("preserves a real creation failure and allows a later retry", async (t) => {
  let posts = 0;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    if (options.method === "POST") {
      posts++;
      return new Response("server unavailable", { status: 500 });
    }
    return Response.json([]);
  });
  await assert.rejects(createOrGetJellyfinUser("3"), /Jellyfin 500/);
  await assert.rejects(createOrGetJellyfinUser("3"), /Jellyfin 500/);
  assert.equal(posts, 2);
});
