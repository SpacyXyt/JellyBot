import type { NextFunction, Request, Response } from "express";
import crypto from "node:crypto";
import { SignJWT, jwtVerify } from "jose";

import { config } from "./config.js";
import { getSubscription, setJellyfinUserId } from "./db.js";
import {
  ensureSubscriptionUser
} from "./jellyfin.js";

const SESSION_COOKIE = "jelly_session";
const OAUTH_STATE_COOKIE = "discord_oauth_state";

const SESSION_MAX_AGE = 60 * 60 * 24 * 7; // 7 jours
const OAUTH_STATE_MAX_AGE = 60 * 10; // 10 minutes

const sessionSecret = new TextEncoder().encode(config.sessionSecret);

type SessionPayload = {
  discordUserId: string;
};

type DiscordTokenResponse = {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
};

type DiscordUser = {
  id: string;
  username: string;
  global_name?: string | null;
};

function getCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;

  if (!header) {
    return null;
  }

  const cookies = header.split(";");

  for (const cookie of cookies) {
    const separator = cookie.indexOf("=");

    if (separator === -1) {
      continue;
    }

    const key = cookie.slice(0, separator).trim();

    if (key !== name) {
      continue;
    }

    return decodeURIComponent(cookie.slice(separator + 1));
  }

  return null;
}

function setCookie(
  res: Response,
  name: string,
  value: string,
  maxAge: number
) {
  res.append(
    "Set-Cookie",
    [
      `${name}=${encodeURIComponent(value)}`,
      "Path=/",
      "HttpOnly",
      "Secure",
      "SameSite=Lax",
      `Max-Age=${maxAge}`
    ].join("; ")
  );
}

function clearCookie(res: Response, name: string) {
  res.append(
    "Set-Cookie",
    [
      `${name}=`,
      "Path=/",
      "HttpOnly",
      "Secure",
      "SameSite=Lax",
      "Max-Age=0"
    ].join("; ")
  );
}

function generateOAuthState(): string {
  return crypto.randomBytes(32).toString("hex");
}

async function createSessionToken(discordUserId: string) {
  return await new SignJWT({
    discordUserId
  } satisfies SessionPayload)
    .setProtectedHeader({
      alg: "HS256"
    })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE}s`)
    .sign(sessionSecret);
}

export async function verifySessionToken(
  token: string
): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, sessionSecret);

    if (
      typeof payload.discordUserId !== "string" ||
      payload.discordUserId.length === 0
    ) {
      return null;
    }

    return {
      discordUserId: payload.discordUserId
    };
  } catch {
    return null;
  }
}

export async function getSessionFromRequest(
  req: Request
): Promise<SessionPayload | null> {
  const token = getCookie(req, SESSION_COOKIE);

  if (!token) {
    return null;
  }

  return await verifySessionToken(token);
}

export async function getDiscordUserFromOAuth(
  code: string
): Promise<DiscordUser> {
  const body = new URLSearchParams({
    client_id: config.discordOAuthClientId,
    client_secret: config.discordOAuthClientSecret,
    grant_type: "authorization_code",
    code,
    redirect_uri: config.discordOAuthRedirectUri
  });

  const tokenResponse = await fetch(
    "https://discord.com/api/v10/oauth2/token",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body
    }
  );

  if (!tokenResponse.ok) {
    const text = await tokenResponse.text();

    throw new Error(
      `Discord OAuth token error ${tokenResponse.status}: ${text}`
    );
  }

  const token =
    await tokenResponse.json() as DiscordTokenResponse;

  const userResponse = await fetch(
    "https://discord.com/api/v10/users/@me",
    {
      headers: {
        Authorization: `${token.token_type} ${token.access_token}`
      }
    }
  );

  if (!userResponse.ok) {
    const text = await userResponse.text();

    throw new Error(
      `Discord OAuth user error ${userResponse.status}: ${text}`
    );
  }

  return await userResponse.json() as DiscordUser;
}

export function discordLogin(req: Request, res: Response) {
  const state = generateOAuthState();

  setCookie(
    res,
    OAUTH_STATE_COOKIE,
    state,
    OAUTH_STATE_MAX_AGE
  );

  const params = new URLSearchParams({
    client_id: config.discordOAuthClientId,
    redirect_uri: config.discordOAuthRedirectUri,
    response_type: "code",
    scope: "identify",
    state
  });

  res.redirect(
    `https://discord.com/oauth2/authorize?${params.toString()}`
  );
}

export async function discordCallback(
  req: Request,
  res: Response
) {
  try {
    const code =
      typeof req.query.code === "string"
        ? req.query.code
        : null;

    const state =
      typeof req.query.state === "string"
        ? req.query.state
        : null;

    if (!code || !state) {
      res.status(400).send(`
        <!DOCTYPE html>
        <html lang="fr">
          <head>
            <meta charset="UTF-8">
            <title>Authentification</title>
          </head>
          <body>
            <h1>Authentification invalide</h1>
            <p>Le code OAuth Discord est manquant.</p>
          </body>
        </html>
      `);

      return;
    }

    const storedState = getCookie(
      req,
      OAUTH_STATE_COOKIE
    );

    if (
        !storedState ||
        storedState.length !== state.length ||
        !crypto.timingSafeEqual(
            Buffer.from(storedState),
            Buffer.from(state)
        )
        ) {
        console.log("[OAuth] State verification failed");
        console.log("[OAuth] Stored:", storedState);
        console.log("[OAuth] Received:", state);

        res.status(400).send(`
            <!DOCTYPE html>
            <html lang="fr">
            <head>
                <meta charset="UTF-8">
                <title>Authentification</title>
            </head>
            <body>
                <h1>Authentification refusée</h1>
                <p>La vérification de sécurité a échoué.</p>
            </body>
            </html>
        `);
        return;
    }

    clearCookie(res, OAUTH_STATE_COOKIE);

    const discordUser =
      await getDiscordUserFromOAuth(code);

    const discordUserId = discordUser.id;

    const subscription =
      await getSubscription(discordUserId);

    /*
     * On crée toujours une session Discord valide.
     *
     * L'accès à Jellyfin est ensuite contrôlé à chaque requête
     * avec PostgreSQL.
     */
    const sessionToken =
      await createSessionToken(discordUserId);

    setCookie(
      res,
      SESSION_COOKIE,
      sessionToken,
      SESSION_MAX_AGE
    );

    /*
     * Si l'utilisateur possède un abonnement actif mais
     * que son utilisateur Jellyfin n'existe pas encore,
     * on le crée automatiquement.
     */
    if (
      subscription &&
      (
        subscription.status === "active" ||
        subscription.status === "trialing"
      )
    ) {
      if (!subscription.jellyfin_user_id) {
        const jellyfinUser =
          await ensureSubscriptionUser(discordUserId);

        await setJellyfinUserId(
          discordUserId,
          jellyfinUser.Id
        );
      }

      res.redirect(
        `${config.publicBaseUrl}/jellyfin/web`
      );

      return;
    }

    res.status(403).send(`
      <!DOCTYPE html>
      <html lang="fr">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>Abonnement requis</title>

          <style>
            body {
              margin: 0;
              min-height: 100vh;
              display: flex;
              align-items: center;
              justify-content: center;
              background: #090f10;
              color: #fff;
              font-family: Arial, sans-serif;
            }

            .card {
              width: min(420px, calc(100% - 40px));
              padding: 32px;
              border-radius: 16px;
              background: #11191a;
              border: 1px solid rgba(185, 222, 197, 0.15);
              text-align: center;
            }

            h1 {
              margin-top: 0;
            }

            p {
              color: #aab7b0;
              line-height: 1.6;
            }

            a {
              display: inline-block;
              margin-top: 16px;
              padding: 12px 18px;
              border-radius: 8px;
              background: #b9dec5;
              color: #090f10;
              text-decoration: none;
              font-weight: bold;
            }
          </style>
        </head>

        <body>
          <div class="card">
            <h1>Abonnement requis</h1>

            <p>
              Votre compte Discord est correctement authentifié,
              mais aucun abonnement Jellyfin actif n'est associé
              à votre compte.
            </p>

            <a href="${config.publicBaseUrl}">
              Retour
            </a>
          </div>
        </body>
      </html>
    `);
  } catch (error) {
    console.error("Discord OAuth callback error:", error);

    res.status(500).send(`
      <!DOCTYPE html>
      <html lang="fr">
        <head>
          <meta charset="UTF-8">
          <title>Erreur</title>
        </head>

        <body>
          <h1>Erreur d'authentification</h1>
          <p>Impossible de terminer la connexion Discord.</p>
        </body>
      </html>
    `);
  }
}

export type JellyfinAccessResult =
  | {
      ok: true;
      discordUserId: string;
      jellyfinUserId: string;
    }
  | {
      ok: false;
      status: 401 | 403;
      message: string;
    };

export async function checkJellyfinAccess(
  req: Request
): Promise<JellyfinAccessResult> {
  const session =
    await getSessionFromRequest(req);

  if (!session) {
    return {
      ok: false,
      status: 401,
      message: "Authentification Discord requise."
    };
  }

  const subscription =
    await getSubscription(session.discordUserId);

  if (!subscription) {
    return {
      ok: false,
      status: 403,
      message: "Aucun abonnement trouvé."
    };
  }

  const active =
    subscription.status === "active" ||
    subscription.status === "trialing";

  if (!active) {
    return {
      ok: false,
      status: 403,
      message: "Votre abonnement n'est plus actif."
    };
  }

  if (!subscription.jellyfin_user_id) {
    return {
      ok: false,
      status: 403,
      message: "Votre compte Jellyfin n'est pas encore configuré."
    };
  }

  return {
    ok: true,
    discordUserId: session.discordUserId,
    jellyfinUserId: subscription.jellyfin_user_id
  };
}

export async function requireJellyfinAccess(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const access =
    await checkJellyfinAccess(req);

  if (!access.ok) {
    res.status(access.status).send(`
      <!DOCTYPE html>
      <html lang="fr">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>Accès refusé</title>

          <style>
            body {
              margin: 0;
              min-height: 100vh;
              display: flex;
              align-items: center;
              justify-content: center;
              background: #090f10;
              color: white;
              font-family: Arial, sans-serif;
            }

            .card {
              max-width: 500px;
              margin: 20px;
              padding: 30px;
              border-radius: 14px;
              background: #11191a;
              border: 1px solid rgba(185, 222, 197, .15);
              text-align: center;
            }

            p {
              color: #aab7b0;
            }

            a {
              display: inline-block;
              margin-top: 15px;
              padding: 11px 17px;
              background: #b9dec5;
              color: #090f10;
              border-radius: 8px;
              text-decoration: none;
              font-weight: bold;
            }
          </style>
        </head>

        <body>
          <div class="card">
            <h1>Accès refusé</h1>
            <p>${access.message}</p>
            <a href="/auth/discord">
              Se connecter avec Discord
            </a>
          </div>
        </body>
      </html>
    `);

    return;
  }

  /*
   * Disponible dans les handlers suivants si nécessaire.
   */
  res.locals.discordUserId = access.discordUserId;
  res.locals.jellyfinUserId = access.jellyfinUserId;

  next();
}