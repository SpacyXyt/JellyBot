import express from "express";
import httpProxy from "http-proxy";
import crypto from "node:crypto";
import path from "node:path";
import {
  fileURLToPath
} from "node:url";

import { config } from "./config.js";

import {
  stripe,
  handleStripeEvent
} from "./stripe.js";

import {
  discordLogin,
  discordCallback,
  requireJellyfinAccess,
  checkJellyfinAccess
} from "./auth.js";

import {
  authenticateJellyfinUser
} from "./jellyfin.js";

const __filename =
  fileURLToPath(import.meta.url);

const __dirname =
  path.dirname(__filename);

/**
 * Informations utilisées par Jellyfin
 * pour identifier notre client.
 */
const JELLYFIN_CLIENT = "JellyBot";
const JELLYFIN_DEVICE = "Discord";
const JELLYFIN_VERSION = "1.0.0";

/**
 * Génère le même DeviceId que jellyfin.ts.
 */
function jellyfinDeviceId(
  discordUserId: string
): string {
  return crypto
    .createHash("sha256")
    .update(
      `jellybot-device:${discordUserId}`
    )
    .digest("hex");
}

/**
 * Génère le header Authorization moderne
 * de Jellyfin.
 */
function jellyfinAuthorization(
  discordUserId: string,
  accessToken: string
): string {
  const deviceId =
    jellyfinDeviceId(discordUserId);

  return (
    `MediaBrowser ` +
    `Token="${accessToken}", ` +
    `Client="${JELLYFIN_CLIENT}", ` +
    `Device="${JELLYFIN_DEVICE}", ` +
    `DeviceId="${deviceId}", ` +
    `Version="${JELLYFIN_VERSION}"`
  );
}

export function startWeb() {
  const app = express();

  /**
   * ============================================================
   * PUBLIC
   * ============================================================
   */

  app.use(
    express.static(
      path.join(
        __dirname,
        "../public"
      )
    )
  );

  /**
   * ============================================================
   * HEALTH
   * ============================================================
   */

  app.get(
    "/health",
    (_req, res) => {
      res.json({
        ok: true
      });
    }
  );

  /**
   * ============================================================
   * STRIPE
   * ============================================================
   */

  app.post(
    "/webhooks/stripe",
    express.raw({
      type: "application/json"
    }),
    async (req, res) => {
      try {
        const signature =
          req.headers[
            "stripe-signature"
          ];

        if (
          !signature ||
          Array.isArray(signature)
        ) {
          res
            .status(400)
            .send(
              "Missing Stripe signature"
            );

          return;
        }

        const event =
          stripe.webhooks.constructEvent(
            req.body,
            signature,
            config.stripeWebhookSecret
          );

        await handleStripeEvent(
          event
        );

        res.sendStatus(200);
      } catch (error) {
        console.error(
          "Stripe webhook error:",
          error
        );

        res
          .status(400)
          .send(
            "Webhook error"
          );
      }
    }
  );

  /**
   * ============================================================
   * STRIPE SUCCESS / CANCEL
   * ============================================================
   */

  app.get(
    "/success",
    (_req, res) => {
      res.type("html").send(`
        <!DOCTYPE html>
        <html lang="fr">
        <head>
          <meta charset="UTF-8">

          <meta
            name="viewport"
            content="width=device-width, initial-scale=1"
          >

          <title>Abonnement activé</title>
        </head>

        <body>
          <h1>Abonnement activé</h1>

          <p>
            Votre paiement a été accepté.
            Votre accès Jellyfin va être activé.
          </p>

          <a href="${config.publicBaseUrl}/auth/discord">
            Accéder à Jellyfin
          </a>
        </body>
        </html>
      `);
    }
  );

  app.get(
    "/cancel",
    (_req, res) => {
      res.type("html").send(`
        <!DOCTYPE html>
        <html lang="fr">
        <head>
          <meta charset="UTF-8">

          <meta
            name="viewport"
            content="width=device-width, initial-scale=1"
          >

          <title>Paiement annulé</title>
        </head>

        <body>
          <h1>Paiement annulé</h1>

          <p>
            Le paiement n'a pas été finalisé.
          </p>

          <a href="${config.publicBaseUrl}">
            Retour
          </a>
        </body>
        </html>
      `);
    }
  );

  /**
   * ============================================================
   * DISCORD OAUTH
   * ============================================================
   */

  app.get(
    "/auth/discord",
    discordLogin
  );

  app.get(
    "/auth/callback",
    discordCallback
  );

  /**
   * ============================================================
   * JELLYFIN AUTO LOGIN
   * ============================================================
   *
   * Cette route reçoit le token temporaire généré
   * par le callback Discord.
   *
   * Elle vérifie la session Discord + abonnement.
   *
   * Puis elle initialise le localStorage de Jellyfin Web.
   *
   * ============================================================
   */

  app.get(
    "/auth/jellyfin",
    async (req, res) => {
      try {
        const token =
          typeof req.query.token === "string"
            ? req.query.token
            : null;

        if (!token) {
          res
            .status(400)
            .send(
              "Missing authentication token"
            );

          return;
        }

        /**
         * Vérification de la session Discord
         * et de l'abonnement.
         */
        const access =
          await checkJellyfinAccess(
            req
          );

        if (!access.ok) {
          res
            .status(access.status)
            .send(
              access.message
            );

          return;
        }

        /**
         * Décodage du payload.
         */
        let payload: {
          accessToken: string;
          userId: string;
          serverId: string;
        };

        try {
          payload =
            JSON.parse(
              Buffer.from(
                token,
                "base64url"
              ).toString("utf8")
            );
        } catch {
          res
            .status(400)
            .send(
              "Invalid authentication token"
            );

          return;
        }

        /**
         * Vérification du contenu du token.
         */
        if (
          !payload ||
          typeof payload.accessToken !== "string" ||
          typeof payload.userId !== "string" ||
          typeof payload.serverId !== "string"
        ) {
          res
            .status(400)
            .send(
              "Invalid authentication payload"
            );

          return;
        }

        /**
         * Protection contre l'utilisation du token
         * pour un autre utilisateur.
         */
        if (
          payload.userId !==
          access.jellyfinUserId
        ) {
          res
            .status(403)
            .send(
              "Invalid Jellyfin user"
            );

          return;
        }

        /**
         * URL publique utilisée par Jellyfin Web.
         *
         * IMPORTANT :
         * ne jamais envoyer jellyfinProxyTarget
         * au navigateur car il peut s'agir de :
         *
         * http://10.8.0.2:8096
         */
        const publicJellyfinUrl =
          `${config.publicBaseUrl}${config.jellyfinProxyPath}`;

        /**
         * Credentials utilisés par Jellyfin Web.
         */
        const credentials = {
          Servers: [
            {
              AccessToken:
                payload.accessToken,

              UserId:
                payload.userId,

              Id:
                payload.serverId,

              ServerId:
                payload.serverId,

              LocalAddress:
                publicJellyfinUrl,

              RemoteAddress:
                publicJellyfinUrl,

              ManualAddress:
                publicJellyfinUrl
            }
          ]
        };

        /**
         * Informations utilisateur Jellyfin.
         */
        const userData = {
          Id:
            payload.userId,

          ServerId:
            payload.serverId,

          EnableAutoLogin:
            true
        };

        const credentialsJson =
          JSON.stringify(
            credentials
          );

        const userDataJson =
          JSON.stringify(
            userData
          );

        /**
         * Protection contre l'injection HTML.
         */
        const safeCredentials =
          credentialsJson.replace(
            /</g,
            "\\u003c"
          );

        const safeUserData =
          userDataJson.replace(
            /</g,
            "\\u003c"
          );

        /**
         * Nettoyage de l'URL après utilisation.
         *
         * Le token n'est pas conservé dans l'URL
         * une fois Jellyfin chargé.
         */
        const jellyfinWebUrl =
          `${publicJellyfinUrl}/web/`;

        res.type("html").send(`
          <!DOCTYPE html>

          <html lang="fr">

          <head>
            <meta charset="UTF-8">

            <meta
              name="viewport"
              content="width=device-width, initial-scale=1"
            >

            <title>Connexion à Jellyfin</title>

            <style>
              html,
              body {
                margin: 0;
                width: 100%;
                height: 100%;

                background: #090f10;
                color: white;

                font-family:
                  Arial,
                  sans-serif;
              }

              body {
                display: flex;
                align-items: center;
                justify-content: center;
              }

              .loading {
                text-align: center;
              }

              .loading h1 {
                margin-bottom: 8px;
              }

              .loading p {
                color: #aab7b0;
              }
            </style>
          </head>

          <body>
            <div class="loading">
              <h1>
                Connexion à Jellyfin...
              </h1>

              <p>
                Votre abonnement est actif.
              </p>
            </div>

            <script>
              (() => {
                try {
                  const credentials =
                    ${safeCredentials};

                  const user =
                    ${safeUserData};

                  /**
                   * Identifiants Jellyfin Web.
                   */
                  localStorage.setItem(
                    "jellyfin_credentials",
                    JSON.stringify(
                      credentials
                    )
                  );

                  /**
                   * Informations utilisateur.
                   */
                  const userKey =
                    "user-" +
                    user.Id +
                    "-" +
                    user.ServerId;

                  localStorage.setItem(
                    userKey,
                    JSON.stringify(
                      user
                    )
                  );

                  /**
                   * Active l'auto-login.
                   */
                  localStorage.setItem(
                    "enableAutoLogin",
                    "true"
                  );

                  /**
                   * Redirection vers Jellyfin.
                   */
                  window.location.replace(
                    ${JSON.stringify(
                      jellyfinWebUrl
                    )}
                  );
                } catch (error) {
                  console.error(
                    "Jellyfin auto-login error:",
                    error
                  );

                  document.body.innerHTML = \`
                    <div class="loading">
                      <h1>Erreur</h1>

                      <p>
                        Impossible de connecter automatiquement
                        votre compte Jellyfin.
                      </p>

                      <p>
                        Rechargez la page ou reconnectez-vous.
                      </p>
                    </div>
                  \`;
                }
              })();
            </script>
          </body>

          </html>
        `);
      } catch (error) {
        console.error(
          "Jellyfin auto-login error:",
          error
        );

        res
          .status(500)
          .send(
            "Unable to authenticate with Jellyfin"
          );
      }
    }
  );

  /**
   * ============================================================
   * LOGOUT
   * ============================================================
   */

  app.get(
    "/auth/logout",
    (_req, res) => {
      res.append(
        "Set-Cookie",
        [
          "jelly_session=",
          "Path=/",
          "HttpOnly",
          "Secure",
          "SameSite=Lax",
          "Max-Age=0"
        ].join("; ")
      );

      res.redirect(
        config.publicBaseUrl
      );
    }
  );

  /**
   * ============================================================
   * JELLYFIN REVERSE PROXY
   * ============================================================
   */

  const jellyfinProxy =
    httpProxy.createProxyServer({
      target:
        config.jellyfinProxyTarget,

      changeOrigin: true,

      ws: true,

      xfwd: true,

      secure: false
    });

  jellyfinProxy.on(
    "error",
    (error, _req, res) => {
      console.error(
        "Jellyfin proxy error:",
        error
      );

      if (
        res &&
        "writeHead" in res &&
        typeof res.writeHead ===
          "function"
      ) {
        const response =
          res as import("node:http")
            .ServerResponse;

        if (!response.headersSent) {
          response.writeHead(
            502,
            {
              "Content-Type":
                "text/plain; charset=utf-8"
            }
          );
        }

        response.end(
          "Jellyfin proxy error"
        );
      }
    }
  );

  /**
   * ============================================================
   * HTTP JELLYFIN PROXY
   * ============================================================
   */

  app.use(
    async (
      req,
      res,
      next
    ) => {
      const prefix =
        config.jellyfinProxyPath;

      const isJellyfinRequest =
        req.path === prefix ||
        req.path.startsWith(
          `${prefix}/`
        );

      if (!isJellyfinRequest) {
        next();

        return;
      }

      await requireJellyfinAccess(
        req,
        res,
        async () => {
          try {
            /**
             * ID Discord provenant de la session.
             */
            const discordUserId =
              res.locals.discordUserId;

            if (
              typeof discordUserId !==
              "string"
            ) {
              if (!res.headersSent) {
                res
                  .status(401)
                  .send(
                    "Discord session missing"
                  );
              }

              return;
            }

            /**
             * Authentification du compte Jellyfin
             * côté serveur.
             */
            const jellyfin =
              await authenticateJellyfinUser(
                discordUserId
              );

            /**
             * Le navigateur peut envoyer son propre
             * Authorization ou d'anciens tokens Jellyfin.
             *
             * On les supprime afin qu'un utilisateur
             * ne puisse pas utiliser le token d'un autre compte.
             */
            delete req.headers.authorization;

            delete req.headers[
              "x-emby-token"
            ];

            delete req.headers[
              "x-mediabrowser-token"
            ];

            /**
             * Nouveau header Jellyfin moderne.
             */
            const authorization =
              jellyfinAuthorization(
                discordUserId,
                jellyfin.accessToken
              );

            /**
             * Proxy HTTP vers Jellyfin.
             */
            jellyfinProxy.web(
              req,
              res,
              {
                target:
                  config.jellyfinProxyTarget,

                headers: {
                  Authorization:
                    authorization
                }
              }
            );
          } catch (error) {
            console.error(
              "Jellyfin authentication error:",
              error
            );

            if (!res.headersSent) {
              res
                .status(502)
                .send(
                  "Unable to authenticate with Jellyfin"
                );
            }
          }
        }
      );
    }
  );

  /**
   * ============================================================
   * 404
   * ============================================================
   */

  app.use(
    (_req, res) => {
      res
        .status(404)
        .json({
          error: "Not found"
        });
    }
  );

  /**
   * ============================================================
   * HTTP SERVER
   * ============================================================
   */

  const server =
    app.listen(
      config.webPort,
      "0.0.0.0",
      () => {
        console.log(
          `HTTP server listening on :${config.webPort}`
        );

        console.log(
          `Jellyfin proxy: ${config.jellyfinProxyPath} -> ${config.jellyfinProxyTarget}`
        );
      }
    );

  /**
   * ============================================================
   * JELLYFIN WEBSOCKETS
   * ============================================================
   */

  server.on(
    "upgrade",
    async (
      req,
      socket,
      head
    ) => {
      try {
        const rawUrl =
          req.url || "/";

        const host =
          req.headers.host ||
          "localhost";

        const parsed =
          new URL(
            rawUrl,
            `http://${host}`
          );

        const prefix =
          config.jellyfinProxyPath;

        const isJellyfinRequest =
          parsed.pathname ===
            prefix ||
          parsed.pathname.startsWith(
            `${prefix}/`
          );

        if (!isJellyfinRequest) {
          socket.destroy();

          return;
        }

        /**
         * Vérification Discord + abonnement.
         */
        const access =
          await checkJellyfinAccess(
            req as any
          );

        if (!access.ok) {
          socket.write(
            [
              `HTTP/1.1 ${access.status} ${
                access.status === 401
                  ? "Unauthorized"
                  : "Forbidden"
              }`,

              "Content-Type: text/plain",

              "Connection: close",

              "",

              access.message
            ].join("\r\n")
          );

          socket.destroy();

          return;
        }

        /**
         * Authentification Jellyfin côté serveur.
         */
        const jellyfin =
          await authenticateJellyfinUser(
            access.discordUserId
          );

        /**
         * Empêche le client d'envoyer son propre token.
         */
        delete req.headers.authorization;

        delete req.headers[
          "x-emby-token"
        ];

        delete req.headers[
          "x-mediabrowser-token"
        ];

        /**
         * Header moderne Jellyfin.
         */
        const authorization =
          jellyfinAuthorization(
            access.discordUserId,
            jellyfin.accessToken
          );

        /**
         * Proxy WebSocket avec le token
         * du compte Jellyfin correspondant.
         */
        jellyfinProxy.ws(
          req,
          socket,
          head,
          {
            target:
              config.jellyfinProxyTarget,

            headers: {
              Authorization:
                authorization
            }
          }
        );
      } catch (error) {
        console.error(
          "Jellyfin WebSocket auth error:",
          error
        );

        socket.destroy();
      }
    }
  );

  return server;
}