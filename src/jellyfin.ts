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
          `MediaBrowser Token="${config.jellyfinApiKey}"`,

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
function jellyfinPassword(discordUserId: string): string {
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
 * On utilise l'API admin de Jellyfin.
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
 * Authentifie le compte Jellyfin et récupère
 * son AccessToken.
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

  /**
   * Jellyfin AuthenticateByName ne nécessite
   * pas le token admin.
   */
  const response = await fetch(
    `${config.jellyfinUrl}/Users/AuthenticateByName`,
    {
      method: "POST",

      headers: {
        "Content-Type":
          "application/json",

        "X-Emby-Authorization":
          'MediaBrowser Client="VexLabs", Device="Web", DeviceId="vexlabs-discord", Version="1.0.0"'
      },

      body: JSON.stringify({
        Username: username,
        Pw: password
      })
    }
  );

  /**
   * Si le compte existait avant cette nouvelle version
   * du code, il peut ne pas encore avoir de mot de passe.
   *
   * On le configure alors avec notre mot de passe interne.
   */
  if (response.status === 401) {
    await setJellyfinPassword(
      user.Id,
      password
    );

    const retry =
      await fetch(
        `${config.jellyfinUrl}/Users/AuthenticateByName`,
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json",

            "X-Emby-Authorization":
              'MediaBrowser Client="VexLabs", Device="Web", DeviceId="vexlabs-discord", Version="1.0.0"'
          },

          body: JSON.stringify({
            Username: username,
            Pw: password
          })
        }
      );

    if (!retry.ok) {
      const text =
        await retry.text();

      throw new Error(
        `Jellyfin authentication failed after password setup ${retry.status}: ${text}`
      );
    }

    const auth =
      await retry.json() as JellyfinAuthenticationResult;

    return {
      user: auth.User,
      accessToken: auth.AccessToken,
      serverId: auth.ServerId
    };
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

    EnableMediaPlayback: active,

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