import express from "express";
import httpProxy from "http-proxy";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function startWeb() {
  const app = express();

  /*
   * ============================================================
   * PUBLIC
   * ============================================================
   */

  app.use(
    express.static(
      path.join(__dirname, "../public")
    )
  );

  /*
   * ============================================================
   * HEALTH
   * ============================================================
   */

  app.get("/health", (_req, res) => {
    res.json({
      ok: true
    });
  });

  /*
   * ============================================================
   * STRIPE
   *
   * IMPORTANT :
   * express.raw() doit être utilisé ici avant tout
   * express.json(), car Stripe vérifie la signature avec
   * le body brut.
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
          req.headers["stripe-signature"];

        if (
          !signature ||
          Array.isArray(signature)
        ) {
          res
            .status(400)
            .send("Missing Stripe signature");

          return;
        }

        const event =
          stripe.webhooks.constructEvent(
            req.body,
            signature,
            config.stripeWebhookSecret
          );

        /*
         * Toute la logique Stripe doit être centralisée
         * dans handleStripeEvent().
         */
        await handleStripeEvent(event);

        res.sendStatus(200);
      } catch (error) {
        console.error(
          "Stripe webhook error:",
          error
        );

        res
          .status(400)
          .send("Webhook error");
      }
    }
  );

  /*
   * ============================================================
   * STRIPE SUCCESS / CANCEL
   * ============================================================
   */

  app.get("/success", (_req, res) => {
    res.type("html").send(`
      <!DOCTYPE html>
      <html lang="fr">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>Abonnement activé</title>
        </head>

        <body>
          <h1>Abonnement activé</h1>

          <p>
            Votre paiement a été accepté.
            Votre accès Jellyfin va être activé.
          </p>

          <a href="${config.publicBaseUrl}/auth/discord">
            Accéder à mon compte
          </a>
        </body>
      </html>
    `);
  });

  app.get("/cancel", (_req, res) => {
    res.type("html").send(`
      <!DOCTYPE html>
      <html lang="fr">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
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
  });

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
   * LOGOUT
   *
   * Le cookie est supprimé côté navigateur.
   * L'accès Jellyfin reste de toute façon protégé
   * par PostgreSQL à chaque requête.
   * ============================================================
   */

  app.get("/auth/logout", (_req, res) => {
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
  });

  /*
   * ============================================================
   * JELLYFIN REVERSE PROXY
   *
   * On conserve le préfixe /jellyfin.
   *
   * Exemple :
   *
   * https://jellybot.vexlabs.fr/jellyfin/web/
   *
   * devient côté Jellyfin :
   *
   * http://jellyfin:8096/jellyfin/web/
   *
   * ============================================================
   */

  const jellyfinProxy =
    httpProxy.createProxyServer({
      target: config.jellyfinProxyTarget,
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

      /*
       * res peut être un ServerResponse ou un socket.
       */
      if (
        res &&
        "writeHead" in res &&
        typeof res.writeHead === "function"
      ) {
        const response =
          res as import("node:http").ServerResponse;

        if (!response.headersSent) {
          response.writeHead(502, {
            "Content-Type": "text/plain; charset=utf-8"
          });
        }

        response.end(
          "Jellyfin proxy error"
        );
      }
    }
  );

  /*
   * HTTP classique :
   *
   * On ne monte PAS app.use("/jellyfin", ...)
   * afin de conserver /jellyfin dans req.url.
   */
  app.use(
    async (req, res, next) => {
      const prefix =
        config.jellyfinProxyPath;

      const isJellyfinRequest =
        req.path === prefix ||
        req.path.startsWith(`${prefix}/`);

      if (!isJellyfinRequest) {
        next();
        return;
      }

      console.log(`[Proxy] Target: ${config.jellyfinProxyTarget}`);
      console.log(`[Proxy] Path: ${req.path}`);

      await requireJellyfinAccess(req, res, () => {
        jellyfinProxy.web(req, res, {
          target: config.jellyfinProxyTarget
        });
      });
    }
  );

  /*
   * ============================================================
   * 404
   * ============================================================
   */

  app.use(
    (_req, res) => {
      res.status(404).json({
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
   *
   * Jellyfin utilise des WebSockets.
   *
   * Express ne passe pas par les middlewares HTTP classiques
   * lors d'un "upgrade", donc on vérifie manuellement la
   * session JWT ici.
   * ============================================================
   */

  server.on(
    "upgrade",
    async (req, socket, head) => {
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
          parsed.pathname === prefix ||
          parsed.pathname.startsWith(
            `${prefix}/`
          );

        /*
         * Le serveur Express peut avoir d'autres WebSockets
         * dans le futur. On ne détruit donc pas ceux qui ne
         * concernent pas Jellyfin.
         */
        if (!isJellyfinRequest) {
          return;
        }

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
         * On conserve /jellyfin dans l'URL.
         * Jellyfin doit donc avoir comme Base URL :
         *
         * /jellyfin
         */

        jellyfinProxy.ws(
          req,
          socket,
          head,
          {
            target:
              config.jellyfinProxyTarget
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