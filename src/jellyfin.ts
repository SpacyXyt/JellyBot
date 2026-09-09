import crypto from "node:crypto";

import { config } from "./config.js";

type JellyfinUser = {
  Id: string;
  Name: string;
  ServerId?: string;

  Policy?: {
    IsAdministrator?: boolean;
    IsHidden?: boolean;
    IsDisabled?: boolean;

    EnableAllFolders?: boolean;
    EnabledFolders?: string[];

    EnableRemoteAccess?: boolean;
    EnableContentDownloading?: boolean;
    EnableContentDeletion?: boolean;

    EnableMediaPlayback?: boolean;
    EnableAudioPlaybackTranscoding?: boolean;
    EnableVideoPlaybackTranscoding?: boolean;

    [key: string]: any;
  };

  [key: string]: any;
};

type JellyfinAuthenticationResult = {
  User: JellyfinUser;
  AccessToken: string;
  ServerId: string;

  SessionInfo?: {
    Id?: string;
    UserId?: string;

    [key: string]: any;
  };
};

export type JellyfinSession = {
  user: JellyfinUser;
  accessToken: string;
  serverId: string;
};

/**
 * Identifiant du client Jellyfin.
 *
 * Il est volontairement stable pour notre backend.
 */
const JELLYFIN_CLIENT = "JellyBot";
const JELLYFIN_DEVICE = "Discord";
const JELLYFIN_VERSION = "1.0.0";

/**
 * Génère un DeviceId unique et stable pour chaque
 * utilisateur Discord.
 *
 * Jellyfin associe les sessions/access tokens au DeviceId.
 */
function jellyfinDeviceId(discordUserId: string): string {
  return crypto
    .createHash("sha256")
    .update(`jellybot-device:${discordUserId}`)
    .digest("hex");
}

/**
 * Header Authorization moderne de Jellyfin.
 *
 * IMPORTANT :
 * On utilise le schéma MediaBrowser.
 *
 * Ne pas utiliser :
 * - X-Emby-Authorization
 * - X-Emby-Token
 * - X-MediaBrowser-Token
 */
function jellyfinAuthorization(
  discordUserId: string,
  accessToken?: string
): string {
  const deviceId = jellyfinDeviceId(discordUserId);

  let header =
    `MediaBrowser ` +
    `Client="${JELLYFIN_CLIENT}", ` +
    `Device="${JELLYFIN_DEVICE}", ` +
    `DeviceId="${deviceId}", ` +
    `Version="${JELLYFIN_VERSION}"`;

  if (accessToken) {
    header =
      `MediaBrowser ` +
      `Token="${accessToken}", ` +
      `Client="${JELLYFIN_CLIENT}", ` +
      `Device="${JELLYFIN_DEVICE}", ` +
      `DeviceId="${deviceId}", ` +
      `Version="${JELLYFIN_VERSION}"`;
  }

  return header;
}

/**
 * Requête API Jellyfin avec la clé API administrateur.
 */
async function jf<T = any>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const response = await fetch(
    `${config.jellyfinUrl}${path}`,
    {
      ...init,

      headers: {
        Authorization:
          `MediaBrowser Token="${config.jellyfinApiKey}", ` +
          `Client="${JELLYFIN_CLIENT}", ` +
          `Device="Backend", ` +
          `DeviceId="jellybot-backend", ` +
          `Version="${JELLYFIN_VERSION}"`,

        "Content-Type": "application/json",

        ...(init.headers || {})
      }
    }
  );

  if (!response.ok) {
    const text = await response.text();

    throw new Error(
      `Jellyfin ${response.status}: ${text}`
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return await response.json() as T;
}

/**
 * Nom du compte Jellyfin correspondant au compte Discord.
 */
function safeName(discordUserId: string): string {
  return `${config.jellyfinUserPrefix}-${discordUserId}`;
}

/**
 * Génère un mot de passe que seul notre backend connaît.
 *
 * Il n'est jamais envoyé à Discord ni au navigateur.
 *
 * IMPORTANT :
 * ne change pas SESSION_SECRET une fois des utilisateurs créés,
 * sinon les anciens mots de passe calculés ne correspondront plus.
 */
function jellyfinPassword(
  discordUserId: string
): string {
  return crypto
    .createHmac(
      "sha256",
      config.sessionSecret
    )
    .update(`jellyfin:${discordUserId}`)
    .digest("base64url");
}

/**
 * Cherche un utilisateur Jellyfin par son nom.
 */
export async function findUserByName(
  name: string
): Promise<JellyfinUser | null> {
  const users =
    await jf<JellyfinUser[]>("/Users");

  return (
    users.find(
      user => user.Name === name
    ) ?? null
  );
}

/**
 * Crée le compte Jellyfin s'il n'existe pas.
 */
export async function createOrGetJellyfinUser(
  discordUserId: string
): Promise<JellyfinUser> {
  const name =
    safeName(discordUserId);

  const existing =
    await findUserByName(name);

  if (existing) {
    return existing;
  }

  const password =
    jellyfinPassword(discordUserId);

  return await jf<JellyfinUser>(
    "/Users/New",
    {
      method: "POST",

      body: JSON.stringify({
        Name: name,

        Password: password,

        AuthenticationProviderId:
          "Jellyfin.Server.Implementations.Users.DefaultAuthenticationProvider",

        PasswordResetProviderId:
          "Jellyfin.Server.Implementations.Users.DefaultPasswordResetProvider"
      })
    }
  );
}

/**
 * Définit le mot de passe interne du compte Jellyfin.
 *
 * Utilisé pour les comptes créés avec une ancienne version
 * du bot qui n'avaient éventuellement pas encore de mot de passe.
 */
async function setJellyfinPassword(
  userId: string,
  password: string
): Promise<void> {
  await jf<void>(
    `/Users/${encodeURIComponent(userId)}/Password`,
    {
      method: "POST",

      body: JSON.stringify({
        CurrentPw: "",
        NewPw: password,
        ResetPassword: false
      })
    }
  );
}

/**
 * Authentifie le compte Jellyfin et récupère son AccessToken.
 */
export async function authenticateJellyfinUser(
  discordUserId: string
): Promise<JellyfinSession> {
  const user =
    await createOrGetJellyfinUser(
      discordUserId
    );

  const username = user.Name;

  const password =
    jellyfinPassword(discordUserId);

  const authorization =
    jellyfinAuthorization(
      discordUserId
    );

  /**
   * Première tentative.
   */
  let response = await fetch(
    `${config.jellyfinUrl}/Users/AuthenticateByName`,
    {
      method: "POST",

      headers: {
        "Content-Type":
          "application/json",

        Authorization:
          authorization
      },

      body: JSON.stringify({
        Username: username,
        Pw: password
      })
    }
  );

  /**
   * Les anciens comptes peuvent ne pas avoir
   * le mot de passe généré par le bot.
   */
  if (response.status === 401) {
    await setJellyfinPassword(
      user.Id,
      password
    );

    /**
     * Nouvelle tentative après configuration
     * du mot de passe.
     */
    response = await fetch(
      `${config.jellyfinUrl}/Users/AuthenticateByName`,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json",

          Authorization:
            authorization
        },

        body: JSON.stringify({
          Username: username,
          Pw: password
        })
      }
    );
  }

  if (!response.ok) {
    const text =
      await response.text();

    throw new Error(
      `Jellyfin authentication failed ${response.status}: ${text}`
    );
  }

  const auth =
    await response.json() as JellyfinAuthenticationResult;

  if (!auth.AccessToken) {
    throw new Error(
      "Jellyfin authentication succeeded but no AccessToken was returned"
    );
  }

  if (!auth.User?.Id) {
    throw new Error(
      "Jellyfin authentication succeeded but no user was returned"
    );
  }

  return {
    user: auth.User,
    accessToken: auth.AccessToken,
    serverId: auth.ServerId
  };
}

/**
 * Active / désactive l'utilisateur Jellyfin.
 */
export async function setUserActive(
  userId: string,
  active: boolean
): Promise<void> {
  const user =
    await jf<JellyfinUser>(
      `/Users/${encodeURIComponent(userId)}`
    );

  if (!user) {
    throw new Error(
      `User ${userId} not found`
    );
  }

  const policy = {
    ...user.Policy,

    IsDisabled: !active,

    EnableAllFolders:
      !config.jellyfinLibraryId,

    EnabledFolders:
      config.jellyfinLibraryId
        ? [config.jellyfinLibraryId]
        : undefined,

    EnableRemoteAccess: false,

    EnableContentDownloading: false,

    EnableContentDeletion: false,

    EnableMediaPlayback:
      active,

    EnableAudioPlaybackTranscoding:
      active,

    EnableVideoPlaybackTranscoding:
      active
  };

  await jf<void>(
    `/Users/${encodeURIComponent(userId)}/Policy`,
    {
      method: "POST",

      body: JSON.stringify(policy)
    }
  );
}

/**
 * Prépare entièrement le compte Jellyfin :
 *
 * - création
 * - activation
 * - authentification
 * - récupération du token
 */
export async function ensureSubscriptionUser(
  discordUserId: string
): Promise<JellyfinSession> {
  const user =
    await createOrGetJellyfinUser(
      discordUserId
    );

  await setUserActive(
    user.Id,
    true
  );

  return await authenticateJellyfinUser(
    discordUserId
  );
}

/**
 * Désactive un compte Jellyfin.
 */
export async function disableSubscriptionUser(
  jellyfinUserId: string
): Promise<void> {
  await setUserActive(
    jellyfinUserId,
    false
  );
}