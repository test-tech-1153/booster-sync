"use strict";

/**
 * Monovault booster sync
 *
 * Reads Discord boosters in the live guild, looks up each linked Roblox
 * account through Bloxlink, and writes the list to a Roblox datastore
 * when it has changed.
 *
 * Secrets come from the environment. This script never prints them.
 */

const DISCORD_GUILD_ID = "1549230599154176152";
const DISCORD_API = "https://discord.com/api/v10";
const BLOXLINK_API = "https://api.blox.link/v4/public";
const ROBLOX_API = "https://apis.roblox.com/cloud/v2";
const DATASTORE_NAME = "SupporterWall";
const BOOSTERS_KEY = "boosters";
const CACHE_KEY = "lookup-cache";
const USER_AGENT = "MonovaultBoosterSync/1.0";

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || "";
const BLOXLINK_API_KEY = process.env.BLOXLINK_API_KEY || "";
const ROBLOX_OPEN_CLOUD_KEY = process.env.ROBLOX_OPEN_CLOUD_KEY || "";
const ROBLOX_UNIVERSE_ID = (process.env.ROBLOX_UNIVERSE_ID || "").trim();

const SECRET_VALUES = [
  DISCORD_BOT_TOKEN,
  BLOXLINK_API_KEY,
  ROBLOX_OPEN_CLOUD_KEY,
].filter((value) => value && value.length > 0);

function redact(value) {
  let text = String(value ?? "");
  for (const secret of SECRET_VALUES) {
    if (secret && secret.length > 3) {
      text = text.split(secret).join("***");
    }
  }
  text = text.replace(/Bot\s+[A-Za-z0-9._-]+/g, "Bot ***");
  text = text.replace(/x-api-key["']?\s*[:=]\s*["'][^"'\s]+/gi, "x-api-key: ***");
  text = text.replace(/Authorization["']?\s*[:=]\s*["'][^"'\s]+/gi, "Authorization: ***");
  return text;
}

function log(...parts) {
  console.log(...parts.map((part) => (typeof part === "string" ? redact(part) : part)));
}

function fail(message, extra) {
  const suffix = extra ? ` ${redact(extra)}` : "";
  console.error(`Error: ${redact(message)}${suffix}`);
  process.exit(1);
}

function requireSecrets() {
  const missing = [];
  if (!DISCORD_BOT_TOKEN) missing.push("DISCORD_BOT_TOKEN");
  if (!BLOXLINK_API_KEY) missing.push("BLOXLINK_API_KEY");
  if (!ROBLOX_OPEN_CLOUD_KEY) missing.push("ROBLOX_OPEN_CLOUD_KEY");
  if (!ROBLOX_UNIVERSE_ID) missing.push("ROBLOX_UNIVERSE_ID");
  if (missing.length) {
    fail(
      `Missing required secret${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}. ` +
        "Add them under the repo Settings > Secrets and variables > Actions."
    );
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryAfterMs(response, fallbackMs) {
  const header = response.headers.get("retry-after") || response.headers.get("Retry-After");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(Math.max(seconds * 1000, 250), 60_000);
    }
    const when = Date.parse(header);
    if (!Number.isNaN(when)) {
      return Math.min(Math.max(when - Date.now(), 250), 60_000);
    }
  }
  return fallbackMs;
}

async function readBody(response) {
  const text = await response.text();
  if (!text) return { text: "", json: null };
  try {
    return { text, json: JSON.parse(text) };
  } catch {
    return { text, json: null };
  }
}

function bodySnippet(body) {
  const source = body.json ? JSON.stringify(body.json) : body.text;
  const trimmed = (source || "").replace(/\s+/g, " ").trim();
  return redact(trimmed).slice(0, 300);
}

async function request(url, options = {}, { attempts = 5, label = "request" } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });
      if (response.status === 429) {
        const body = await readBody(response);
        const errorText = (body.json && (body.json.error || body.json.message)) || body.text || "";
        if (/quota reached|limit for today/i.test(String(errorText))) {
          fail(
            "Bloxlink daily quota was reached. Stopping so later runs can succeed. " +
              "Wait until tomorrow, or raise the limit in the Bloxlink dashboard."
          );
        }
        const waitMs = retryAfterMs(response, Math.min(1000 * 2 ** (attempt - 1), 20_000));
        if (attempt === attempts) {
          throw new Error(`${label} hit rate limits repeatedly (429). Try again in a few minutes.`);
        }
        log(`${label}: rate limited (429). Waiting ${Math.ceil(waitMs / 1000)}s, then retrying.`);
        await sleep(waitMs);
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt === attempts) {
        throw new Error(`${label} failed: ${redact(error && error.message)}`);
      }
      const waitMs = Math.min(1000 * 2 ** (attempt - 1), 10_000);
      log(`${label}: network error. Waiting ${Math.ceil(waitMs / 1000)}s, then retrying.`);
      await sleep(waitMs);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error(`${label} failed after retries`);
}

async function listDiscordBoosters() {
  const boosters = [];
  let after = null;
  let page = 0;
  let totalMembers = 0;

  while (true) {
    const params = new URLSearchParams({ limit: "1000" });
    if (after) params.set("after", after);
    const url = `${DISCORD_API}/guilds/${DISCORD_GUILD_ID}/members?${params}`;
    const response = await request(
      url,
      {
        headers: {
          Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
          "User-Agent": USER_AGENT,
        },
      },
      { label: "Discord member list" }
    );
    const body = await readBody(response);

    if (response.status === 401) {
      fail("Discord rejected the bot token (401). Check the DISCORD_BOT_TOKEN secret.");
    }
    if (response.status === 403) {
      fail(
        "Discord rejected the member list (403). " +
          "Turn on the Server Members privileged intent for the Monovault Ops bot " +
          "in the Discord Developer Portal (Bot > Privileged Gateway Intents), " +
          "save, wait a minute, and rerun this workflow."
      );
    }
    if (!response.ok) {
      fail(
        `Discord member list failed (${response.status}).`,
        bodySnippet(body)
      );
    }
    if (!Array.isArray(body.json)) {
      fail("Discord member list returned an unexpected response.");
    }

    const members = body.json;
    page += 1;
    totalMembers += members.length;

    for (const member of members) {
      const user = member && member.user;
      if (!user || !user.id) continue;
      if (user.bot) continue;
      if (!member.premium_since) continue;
      boosters.push({
        discordId: String(user.id),
        since: String(member.premium_since),
      });
    }

    if (members.length < 1000) break;
    const last = members[members.length - 1];
    const lastId = last && last.user && last.user.id;
    if (!lastId || lastId === after) {
      fail("Discord member list pagination did not advance. Stopping to avoid a loop.");
    }
    after = lastId;
  }

  log(`Discord: ${totalMembers} member${totalMembers === 1 ? "" : "s"} across ${page} page${page === 1 ? "" : "s"}, ${boosters.length} booster${boosters.length === 1 ? "" : "s"}.`);
  return boosters;
}

function parseRobloxId(value) {
  if (value == null || value === "") return null;
  const asString = String(value).trim();
  if (!/^\d+$/.test(asString)) return null;
  const asNumber = Number(asString);
  if (!Number.isSafeInteger(asNumber) || asNumber <= 0) return null;
  return asNumber;
}

async function lookupRobloxId(discordId) {
  const url = `${BLOXLINK_API}/guilds/${DISCORD_GUILD_ID}/discord-to-roblox/${discordId}`;
  const response = await request(
    url,
    {
      headers: {
        Authorization: BLOXLINK_API_KEY,
        "User-Agent": USER_AGENT,
        Accept: "application/json",
      },
    },
    { label: "Bloxlink lookup" }
  );
  const body = await readBody(response);
  const errorText = (body.json && (body.json.error || body.json.message)) || body.text || "";

  if (response.status === 401 || /invalid api key/i.test(String(errorText))) {
    fail("Bloxlink rejected the API key. Check the BLOXLINK_API_KEY secret and that it was created for this Discord server.");
  }
  if (response.status === 403 || /guild id does not match/i.test(String(errorText))) {
    fail("Bloxlink says this API key does not match the Discord server. Create a key for the Monovault server and update BLOXLINK_API_KEY.");
  }
  if (
    response.status === 429 ||
    /quota reached|limit for today/i.test(String(errorText))
  ) {
    fail(
      "Bloxlink daily quota was reached. Stopping so later runs can succeed. " +
        "Wait until tomorrow, or raise the limit in the Bloxlink dashboard."
    );
  }
  if (response.status === 404 || /user not found|not linked/i.test(String(errorText))) {
    return null;
  }
  if (!response.ok) {
    fail(`Bloxlink lookup failed (${response.status}).`, bodySnippet(body));
  }

  const robloxId = parseRobloxId(body.json && body.json.robloxID);
  if (!robloxId) return null;
  return robloxId;
}

function robloxEntryUrl(entryId) {
  const universe = encodeURIComponent(ROBLOX_UNIVERSE_ID);
  const store = encodeURIComponent(DATASTORE_NAME);
  const entry = encodeURIComponent(entryId);
  return `${ROBLOX_API}/universes/${universe}/data-stores/${store}/entries/${entry}`;
}

function robloxHeaders(withJson = false) {
  const headers = {
    "x-api-key": ROBLOX_OPEN_CLOUD_KEY,
    "User-Agent": USER_AGENT,
    Accept: "application/json",
  };
  if (withJson) headers["Content-Type"] = "application/json";
  return headers;
}

function explainRobloxStatus(status) {
  if (status === 401) {
    return "Roblox rejected the Open Cloud key (401). Check the ROBLOX_OPEN_CLOUD_KEY secret.";
  }
  if (status === 403) {
    return (
      "Roblox denied access (403). Check ROBLOX_UNIVERSE_ID, and that the Open Cloud key " +
      "has Datastore read and write on only the Overgrowth experience."
    );
  }
  if (status === 404) {
    return "Roblox could not find that universe, datastore, or entry (404). Check ROBLOX_UNIVERSE_ID.";
  }
  return `Roblox Open Cloud request failed (${status}).`;
}

async function getDatastoreEntry(entryId) {
  const response = await request(
    robloxEntryUrl(entryId),
    { headers: robloxHeaders() },
    { label: `Roblox get ${entryId}` }
  );
  if (response.status === 404) {
    await readBody(response);
    return { missing: true, value: null };
  }
  const body = await readBody(response);
  if (!response.ok) {
    fail(explainRobloxStatus(response.status), bodySnippet(body));
  }
  return { missing: false, value: body.json ? body.json.value : null };
}

async function putDatastoreEntry(entryId, value) {
  const url = `${robloxEntryUrl(entryId)}?allowMissing=true`;
  const response = await request(
    url,
    {
      method: "PATCH",
      headers: robloxHeaders(true),
      body: JSON.stringify({ value }),
    },
    { label: `Roblox write ${entryId}` }
  );
  const body = await readBody(response);
  if (!response.ok) {
    fail(explainRobloxStatus(response.status), bodySnippet(body));
  }
}

function normalizeCache(value) {
  const map = {};
  const source =
    value && typeof value === "object" && value.discordToRoblox && typeof value.discordToRoblox === "object"
      ? value.discordToRoblox
      : {};
  for (const [discordId, robloxId] of Object.entries(source)) {
    const parsed = parseRobloxId(robloxId);
    if (discordId && parsed) map[String(discordId)] = parsed;
  }
  return map;
}

function currentBoosterList(value) {
  if (!value || typeof value !== "object" || !Array.isArray(value.boosters)) return [];
  const list = [];
  for (const row of value.boosters) {
    const robloxId = parseRobloxId(row && row.robloxId);
    if (!robloxId) continue;
    list.push({
      robloxId,
      since: row.since ? String(row.since) : "",
    });
  }
  return list;
}

function compareKey(list) {
  return JSON.stringify(
    [...list]
      .map((row) => ({ robloxId: row.robloxId, since: row.since }))
      .sort((a, b) => a.robloxId - b.robloxId || String(a.since).localeCompare(String(b.since)))
  );
}

async function resolveBoosters(discordBoosters, cache) {
  const resolved = [];
  const nextCache = { ...cache };
  let lookedUp = 0;
  let reused = 0;
  let skipped = 0;

  for (const booster of discordBoosters) {
    let robloxId = nextCache[booster.discordId] || null;
    if (robloxId) {
      reused += 1;
    } else {
      // Small delay so a sudden jump in booster count does not burst the API.
      if (lookedUp > 0) await sleep(200);
      robloxId = await lookupRobloxId(booster.discordId);
      lookedUp += 1;
      if (robloxId) {
        nextCache[booster.discordId] = robloxId;
      } else {
        skipped += 1;
        continue;
      }
    }
    resolved.push({
      robloxId,
      since: booster.since,
    });
  }

  // Drop cache entries for people who are no longer boosting so the cache stays small.
  const active = new Set(discordBoosters.map((row) => row.discordId));
  for (const discordId of Object.keys(nextCache)) {
    if (!active.has(discordId)) delete nextCache[discordId];
  }

  log(
    `Bloxlink: ${lookedUp} lookup${lookedUp === 1 ? "" : "s"}, ${reused} reused from cache, ${skipped} unlinked skipped, ${resolved.length} linked booster${resolved.length === 1 ? "" : "s"}.`
  );
  return { resolved, nextCache };
}

function cacheChanged(previous, next) {
  return JSON.stringify(previous) !== JSON.stringify(next);
}

async function main() {
  requireSecrets();

  const discordBoosters = await listDiscordBoosters();
  const current = await getDatastoreEntry(BOOSTERS_KEY);
  const cacheEntry = await getDatastoreEntry(CACHE_KEY);
  const cache = normalizeCache(cacheEntry.value);

  const { resolved, nextCache } = await resolveBoosters(discordBoosters, cache);
  const previous = currentBoosterList(current.value);
  const sameList = compareKey(previous) === compareKey(resolved);

  if (cacheChanged(cache, nextCache)) {
    await putDatastoreEntry(CACHE_KEY, { discordToRoblox: nextCache });
    log("Datastore: lookup cache updated.");
  }

  if (sameList && !current.missing) {
    log("Datastore: booster list unchanged, no write.");
    return;
  }

  const payload = {
    updatedAt: new Date().toISOString(),
    boosters: resolved
      .slice()
      .sort((a, b) => String(a.since).localeCompare(String(b.since)) || a.robloxId - b.robloxId),
  };
  await putDatastoreEntry(BOOSTERS_KEY, payload);
  log(`Datastore: wrote ${payload.boosters.length} booster${payload.boosters.length === 1 ? "" : "s"} to ${DATASTORE_NAME}/${BOOSTERS_KEY}.`);
}

main().catch((error) => {
  fail(error && error.message ? error.message : "Unexpected failure.");
});
