import { config } from "./config.js";

type JellyfinUser = {
  Id: string;
  Name: string;
  Policy?: {
    IsAdministrator?: boolean;
    IsHidden?: boolean;
    IsDisabled?: boolean;
    EnableAllFolders?: boolean;
    EnableRemoteAccess?: boolean;
    EnableContentDownloading?: boolean;
    EnableContentDeletion?: boolean;
    EnableMediaPlayback?: boolean;
    EnableAudioPlaybackTranscoding?: boolean;
    EnableVideoPlaybackTranscoding?: boolean;
    // Add other policy fields as needed
    [key: string]: any;
  };
};

async function jf<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${config.jellyfinUrl}${path}`, {
    ...init,
    headers: {
      "Authorization": `MediaBrowser Token="${config.jellyfinApiKey}"`,
      "Content-Type": "application/json",
      ...(init.headers || {})
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Jellyfin ${response.status}: ${text}`);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return await response.json() as T;
}

function safeName(discordUserId: string) {
  return `${config.jellyfinUserPrefix}-${discordUserId}`;
}

export async function findUserByName(name: string) {
  const users = await jf<JellyfinUser[]>("/Users");
  return users.find(u => u.Name === name) ?? null;
}

export async function createOrGetJellyfinUser(discordUserId: string) {
  const name = safeName(discordUserId);

  const existing = await findUserByName(name);

  if (existing) {
    return existing;
  }

  return await jf<JellyfinUser>("/Users/New", {
    method: "POST",
    body: JSON.stringify({
      Name: name,
      AuthenticationProviderId: "Jellyfin.Server.Implementations.Users.DefaultAuthenticationProvider",
      PasswordResetProviderId: "Jellyfin.Server.Implementations.Users.DefaultPasswordResetProvider"
    })
  });
}

export async function setUserActive(userId: string, active: boolean) {
  // Get the current user first
  const user = await jf<JellyfinUser>(`/Users/${encodeURIComponent(userId)}`);
  
  if (!user) {
    throw new Error(`User ${userId} not found`);
  }

  // Build the complete policy by merging with existing
  const policy = {
    ...user.Policy,
    IsDisabled: !active,
    EnableAllFolders: !config.jellyfinLibraryId,
    EnableRemoteAccess: false,
    EnableContentDownloading: false,
    EnableContentDeletion: false,
    EnableMediaPlayback: active,
    EnableAudioPlaybackTranscoding: active,
    EnableVideoPlaybackTranscoding: active
  };

  // Update the policy
  await jf<void>(`/Users/${encodeURIComponent(userId)}/Policy`, {
    method: "POST",
    body: JSON.stringify(policy)
  });
}

export async function ensureSubscriptionUser(discordUserId: string) {
  const user = await createOrGetJellyfinUser(discordUserId);
  await setUserActive(user.Id, true);
  return user;
}

export async function disableSubscriptionUser(jellyfinUserId: string) {
  await setUserActive(jellyfinUserId, false);
}