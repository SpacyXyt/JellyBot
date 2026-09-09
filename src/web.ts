import express from "express";

import httpProxy from "http-proxy";

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
  getSubscription
} from "./db.js";

import {
  authenticateJellyfinUser
} from "./jellyfin.js";

const __filename =
  fileURLToPath(import.meta.url);

const __dirname =
  path.dirname(__filename);

export function startWeb() {
  const app = express();

  /*
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

  /*
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

  /*
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

  /*
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

  /*
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

  /*
   * ============================================================
   * JELLYFIN AUTO LOGIN
   * ============================================================
   *
   * Cette route reçoit un token temporaire généré par
   * notre callback Discord.
   *
   * Elle vérifie encore une fois la session Discord + abonnement,
   * puis initialise localStorage de Jellyfin Web.
   *
   * Le navigateur sera alors considéré comme connecté.
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

        /*
         * On vérifie la session Discord.
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

        /*
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

        /*
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

        /*
         * Token Jellyfin nécessaire au Web client.
         *
         * Il est injecté dans localStorage,
         * comme le fait un flux SSO Jellyfin.
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
                config.jellyfinProxyTarget,

              RemoteAddress:
                `${config.publicBaseUrl}${config.jellyfinProxyPath}`,

              ManualAddress:
                `${config.publicBaseUrl}${config.jellyfinProxyPath}`
            }
          ]
        };

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

        /*
         * Protection XSS minimale :
         * les valeurs sont injectées dans JSON.stringify
         * puis dans un script.
         *
         * </script> est explicitement neutralisé.
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
                font-family: Arial, sans-serif;
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
              <h1>Connexion à Jellyfin...</h1>
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

                  /*
                   * Identifiants Jellyfin Web.
                   */
                  localStorage.setItem(
                    "jellyfin_credentials",
                    JSON.stringify(credentials)
                  );

                  /*
                   * Informations utilisateur.
                   */
                  const userKey =
                    "user-" +
                    user.Id +
                    "-" +
                    user.ServerId;

                  localStorage.setItem(
                    userKey,
                    JSON.stringify(user)
                  );

                  /*
                   * Active l'auto-login Jellyfin.
                   */
                  localStorage.setItem(
                    "enableAutoLogin",
                    "true"
                  );

                  /*
                   * Nettoyage de l'URL :
                   * le token ne reste pas dans l'historique.
                   */
                  window.location.replace(
                    ${JSON.stringify(
                      `${config.publicBaseUrl}${config.jellyfinProxyPath}/web/`
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

  /*
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

  /*
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

  /*
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
            /*
             * Récupération de la session Discord.
             */
            const discordUserId =
              res.locals.discordUserId;

            /*
             * On authentifie le compte Jellyfin
             * côté serveur.
             */
            const jellyfin =
              await authenticateJellyfinUser(
                discordUserId
              );

            /*
             * Le navigateur peut envoyer son propre
             * Authorization / X-Emby-Token.
             *
             * On les supprime pour empêcher qu'un token
             * appartenant à un autre compte soit utilisé.
             */
            delete req.headers.authorization;

            delete req.headers[
              "x-emby-token"
            ];

            delete req.headers[
              "x-mediabrowser-token"
            ];

            jellyfinProxy.web(
              req,
              res,
              {
                target:
                  config.jellyfinProxyTarget,

                headers: {
                  "X-Emby-Token":
                    jellyfin.accessToken
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

  /*
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

  /*
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

  /*
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
          return;
        }

        /*
         * Vérification Discord + Stripe.
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

        /*
         * Authentification Jellyfin côté serveur.
         */
        const jellyfin =
          await authenticateJellyfinUser(
            access.discordUserId
          );

        /*
         * Empêche le client d'envoyer son propre token.
         */
        delete req.headers.authorization;

        delete req.headers[
          "x-emby-token"
        ];

        delete req.headers[
          "x-mediabrowser-token"
        ];

        /*
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
              "X-Emby-Token":
                jellyfin.accessToken
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