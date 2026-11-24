# Overgrowth booster sync

This repo keeps the in-game supporter wall in sync with people who boost the Monovault Discord, and copies Discord role membership into the same Roblox datastore.

Every 30 minutes (and whenever you run it by hand) a GitHub Action:

1. Lists Discord boosters and server roles
2. Looks up linked Roblox accounts through Bloxlink
3. Writes boosters to the Roblox datastore `SupporterWall` (key `boosters`) when that list changes
4. Writes Discord roles to the same datastore (key `roles`) when that map changes

The game reads those entries. Supporter scripts handle the supporter tag, the booster item, and the wall. Role data is player attributes and a server function only. The in-game display is built separately.

Nothing here should ever contain a password, token, or API key.

## 1. Create the GitHub repo and push

1. On GitHub, click **New repository**.
2. Name it something like `booster-sync`.
3. Make it **private** (or public — see the minutes note at the bottom).
4. Leave it empty (no README, no .gitignore).
5. On your computer, in this folder, run:

```bash
git remote add origin https://github.com/YOUR_USERNAME/booster-sync.git
git branch -M main
git push -u origin main
```

Replace `YOUR_USERNAME` and the repo name with yours.

## 2. Add the four secrets

In the repo on GitHub: **Settings → Secrets and variables → Actions → New repository secret**.

Add these four names. Paste the values only into the secret boxes, never into a file in this repo or into a chat.

| Secret name | What it is |
| --- | --- |
| `DISCORD_BOT_TOKEN` | The Monovault Ops bot token. Same one already used for Discord setup. |
| `BLOXLINK_API_KEY` | A **new** Bloxlink API key for the Monovault server. |
| `ROBLOX_OPEN_CLOUD_KEY` | A Roblox Open Cloud API key limited to Overgrowth datastores. |
| `ROBLOX_UNIVERSE_ID` | The Overgrowth experience's universe ID (numbers only). |

### Bloxlink key (regenerate this)

The old key was pasted in chat, so do not reuse it.

1. Open the [Bloxlink developer dashboard](https://www.blox.link/dashboard/user/developer).
2. Select the Monovault Discord server and create or regenerate the API key.
3. Copy the new key into the `BLOXLINK_API_KEY` secret.
4. Make sure the official Bloxlink bot is in the Discord server, and that boosters have linked their Roblox account (they can use Bloxlink's verify command if they have not).

### Roblox Open Cloud key and universe ID

1. Open [Creator Dashboard → Open Cloud → API Keys](https://create.roblox.com/dashboard/credentials).
2. Create an API key.
3. Give it access to **Datastores** only, with **read and write** (include create if the list shows it).
4. Limit that access to the **Overgrowth** experience only. If the page lets you limit it to one datastore, pick `SupporterWall`.
5. Paste the key into `ROBLOX_OPEN_CLOUD_KEY`.
6. The universe ID is on the Overgrowth experience page in Creator Dashboard (the number in the URL, or a field labeled Universe ID). Paste only that number into `ROBLOX_UNIVERSE_ID`.

## 3. Turn on the Discord intent

The Monovault Ops bot cannot list boosters until this is on. Existing audit scripts already confirmed the member list returns 403 ("Missing Access") while it is off.

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) and select the Monovault Ops app.
2. Go to **Bot → Privileged Gateway Intents**.
3. Turn **Server Members Intent** on, and save.
4. Wait a minute before running the workflow.

Do not turn on Message Content Intent, and do not change other bots' permissions.

## 4. Run the workflow once by hand

GitHub often will not run a scheduled job until it has been run once manually.

1. In the repo, open the **Actions** tab.
2. Click **Sync boosters**.
3. Click **Run workflow**.
4. Open the run and check that it finished in green. The log should mention how many boosters and roles it found and whether it wrote each entry. It will never print the secrets.

If it fails, the error message should say which step to fix (intent, key, universe ID, and so on).

## 5. Put the scripts and the wall in the game

In Roblox Studio:

1. Add `roblox/SupporterService.server.lua` to **ServerScriptService**.
2. Add `roblox/SupporterChatTag.client.lua` to **StarterPlayer → StarterPlayerScripts**. That file adds the `[Supporter]` chat tag. Overhead tags still work without it.
3. Place a Tool (or other item) in **ServerStorage** named exactly `SupporterItem`. If this is missing, the script warns once in the output and skips the item.
4. Place a wall in **Workspace** named exactly `SupporterWall`, with a **SurfaceGui** on the front. Optional but nicer: add a `SlotTemplate` frame under the SurfaceGui, with an `Avatar` image and a `Name` text label. The script clones that template for each booster. If you skip the template, it writes a name list instead.

5. Add `roblox/DiscordRoles.server.lua` to **ServerScriptService**. It reads the `roles` entry when a player joins, and again about every 5 minutes. It does not create UI. It sets two player attributes:

   - `DiscordRoles` — role names separated by a comma and a space, highest Discord position first
   - `DiscordTopRole` — the name of the highest role, or an empty string

   Other server scripts can call `ServerStorage.GetDiscordRoles:Invoke(player)`. It returns a list of `{name, color, position}` in that same order. Build nametags or menus from those.

Studio playtest after the first successful workflow run. A linked booster should get the tag, the item, and a spot on the wall. A linked member with Discord roles should have `DiscordRoles` and `DiscordTopRole` set.

## Notes

- GitHub scheduled runs can be a few minutes late. They are also not exact to the second.
- Lookups are cached in the datastore key `lookup-cache`. A linked Discord account is reused on later runs. An account Bloxlink does not know is remembered for 24 hours (`negativeLookups`), so unlinked members are not queried again every run. After that, the next run tries once. The cache covers boosters and members who have a synced role.
- Discord roles use the same `SupporterWall` datastore, key `roles`, so the Open Cloud key can stay limited to that one datastore. The `boosters` entry is a separate value and is not changed by the role write. The `roles` value looks like:

  ```json
  {
    "updatedAt": "2026-11-24T00:00:00.000Z",
    "roles": {
      "<discordRoleId>": { "name": "Member", "color": "#c9a84c", "position": 5 }
    },
    "members": {
      "<robloxUserId>": ["<discordRoleId>"]
    }
  }
  ```

  `color` is `#rrggbb`. Discord's default color is `#000000`. `position` is the Discord role position (higher is higher in the list). `members` lists only people Bloxlink could link, and each array is that account's role ids, highest position first. `@everyone` and managed bot roles (`tags.bot_id`) are left out. The Server Booster role (`tags.premium_subscriber`) is included. The sync will not write this entry if its JSON is larger than 4MB (4,194,304 bytes). With the current server size that is a long way off.
- Private GitHub repos on the free plan get **2,000 Actions minutes per month**. This repo runs every **30 minutes** (about 1,440 runs and minutes a month), which fits the free private cap. Every 10 minutes would be about 4,300 minutes, which goes over it. Safer options:
  - Make the repo **public** (standard GitHub-hosted runs on public repos do not use that 2,000-minute cap), or
  - Run less often. Every **15 minutes** is still about 2,880 minutes, so it can still go over. Every **30 minutes** is about 1,440 minutes and fits comfortably.
- To change the schedule, edit `.github/workflows/sync.yml` and change the cron line (for example `'*/30 * * * *'`).
