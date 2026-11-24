"use strict";

/**
 * Monovault booster sync
 *
 * Reads Discord boosters and server roles in the live guild, looks up each
 * linked Roblox account through Bloxlink, and writes the lists to a Roblox
 * datastore when they have changed.
 *
 * Secrets come from the environment. This script never prints them.
 */

const DISCORD_GUILD_ID = "1549230599154176152";
const DISCORD_API = "https://discord.com/api/v10";
const BLOXLINK_API = "https://api.blox.link/v4/public";
const ROBLOX_API = "https://apis.roblox.com/cloud/v2";
const DATASTORE_NAME = "SupporterWall";
const BOOSTERS_KEY = "boosters";
const ROLES_KEY = "roles";
const CACHE_KEY = "lookup-cache";
const USER_AGENT = "MonovaultBoosterSync/1.0";
// Unlinked Discord accounts are remembered so the next runs do not call Bloxlink again.
const NEGATIVE_LOOKUP_TTL_MS = 24 * 60 * 60 * 1000;
// Pause between Bloxlink lookups. 429 responses still back off further.
const LOOKUP_GAP_MS = 200;
// Roblox datastore values cannot exceed 4 MiB. Refuse to write past this.
const DATASTORE_VALUE_LIMIT_BYTES = 4 * 1024 * 1024;

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

async function listDiscordGuild() {
  const members = [];
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

    const pageMembers = body.json;
    page += 1;
    totalMembers += pageMembers.length;

    for (const member of pageMembers) {
      const user = member && member.user;
      if (!user || !user.id) continue;
      if (user.bot) continue;
      const discordId = String(user.id);
      const roleIds = Array.isArray(member.roles) ? member.roles.map((id) => String(id)) : [];
      members.push({ discordId, roleIds });
      if (!member.premium_since) continue;
      boosters.push({
        discordId,
        since: String(member.premium_since),
      });
    }

    if (pageMembers.length < 1000) break;
    const last = pageMembers[pageMembers.length - 1];
    const lastId = last && last.user && last.user.id;
    if (!lastId || lastId === after) {
      fail("Discord member list pagination did not advance. Stopping to avoid a loop.");
    }
    after = lastId;
  }

  log(`Discord: ${totalMembers} member${totalMembers === 1 ? "" : "s"} across ${page} page${page === 1 ? "" : "s"}, ${boosters.length} booster${boosters.length === 1 ? "" : "s"}.`);
  return { members, boosters };
}

function colorToHex(color) {
  let n = Number(color);
  if (!Number.isFinite(n) || n <= 0) n = 0;
  n = Math.min(0xffffff, Math.trunc(n));
  return `#${n.toString(16).padStart(6, "0")}`;
}

function isExcludedRole(role, guildId) {
  if (!role || role.id == null || role.id === "") return true;
  if (String(role.id) === String(guildId)) return true;
  if (role.name === "@everyone") return true;
  // Managed bot roles carry tags.bot_id. The Server Booster role is managed too,
  // but its tag is premium_subscriber and it does not have bot_id, so it stays.
  if (role.tags && role.tags.bot_id) return true;
  return false;
}

async function listDiscordRoles() {
  const url = `${DISCORD_API}/guilds/${DISCORD_GUILD_ID}/roles`;
  const response = await request(
    url,
    {
      headers: {
        Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
        "User-Agent": USER_AGENT,
      },
    },
    { label: "Discord role list" }
  );
  const body = await readBody(response);

  if (response.status === 401) {
    fail("Discord rejected the bot token (401). Check the DISCORD_BOT_TOKEN secret.");
  }
  if (response.status === 403) {
    fail("Discord rejected the role list (403). Check that the bot is still in the server.");
  }
  if (!response.ok) {
    fail(`Discord role list failed (${response.status}).`, bodySnippet(body));
  }
  if (!Array.isArray(body.json)) {
    fail("Discord role list returned an unexpected response.");
  }

  const roles = {};
  let excluded = 0;
  for (const role of body.json) {
    if (isExcludedRole(role, DISCORD_GUILD_ID)) {
      excluded += 1;
      continue;
    }
    const id = String(role.id);
    const position = Number(role.position);
    roles[id] = {
      name: String(role.name ?? ""),
      color: colorToHex(role.color),
      position: Number.isFinite(position) ? Math.trunc(position) : 0,
    };
  }

  const kept = Object.keys(roles).length;
  log(`Discord: ${kept} role${kept === 1 ? "" : "s"} kept, ${excluded} excluded.`);
  return roles;
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

function sortObject(map) {
  const out = {};
  for (const key of Object.keys(map).sort()) out[key] = map[key];
  return out;
}

function normalizeCache(value) {
  const positive = {};
  const negativeUntil = {};
  if (!value || typeof value !== "object") return { positive, negativeUntil };

  const source =
    value.discordToRoblox && typeof value.discordToRoblox === "object" ? value.discordToRoblox : {};
  for (const [discordId, robloxId] of Object.entries(source)) {
    const parsed = parseRobloxId(robloxId);
    if (discordId && parsed) positive[String(discordId)] = parsed;
  }

  const negatives =
    value.negativeLookups && typeof value.negativeLookups === "object" ? value.negativeLookups : {};
  const now = Date.now();
  for (const [discordId, expiresAt] of Object.entries(negatives)) {
    const when = typeof expiresAt === "number" ? expiresAt : Date.parse(String(expiresAt));
    if (discordId && Number.isFinite(when) && when > now) negativeUntil[String(discordId)] = when;
  }
  return { positive, negativeUntil };
}

function cacheRecord(positive, negativeUntil) {
  const negativeLookups = {};
  for (const id of Object.keys(negativeUntil).sort()) {
    negativeLookups[id] = new Date(negativeUntil[id]).toISOString();
  }
  const record = { discordToRoblox: sortObject(positive) };
  if (Object.keys(negativeLookups).length > 0) record.negativeLookups = negativeLookups;
  return record;
}

function canonicalStoredCache(value) {
  const positive = {};
  const negativeLookups = {};
  if (value && typeof value === "object") {
    const source =
      value.discordToRoblox && typeof value.discordToRoblox === "object" ? value.discordToRoblox : {};
    for (const [discordId, robloxId] of Object.entries(source)) {
      const parsed = parseRobloxId(robloxId);
      if (discordId && parsed) positive[String(discordId)] = parsed;
    }
    const negatives =
      value.negativeLookups && typeof value.negativeLookups === "object" ? value.negativeLookups : {};
    for (const [discordId, expiresAt] of Object.entries(negatives)) {
      const when = typeof expiresAt === "number" ? expiresAt : Date.parse(String(expiresAt));
      if (discordId && Number.isFinite(when)) negativeLookups[String(discordId)] = new Date(when).toISOString();
    }
  }
  const record = { discordToRoblox: sortObject(positive) };
  const sortedNeg = sortObject(negativeLookups);
  if (Object.keys(sortedNeg).length > 0) record.negativeLookups = sortedNeg;
  return record;
}

function cacheChanged(previousValue, positive, negativeUntil) {
  return JSON.stringify(canonicalStoredCache(previousValue)) !== JSON.stringify(cacheRecord(positive, negativeUntil));
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

function collectDiscordIds(members, boosters, roleMap) {
  const ids = new Set();
  for (const booster of boosters) ids.add(booster.discordId);
  for (const member of members) {
    if (member.roleIds.some((roleId) => Object.hasOwn(roleMap, roleId))) ids.add(member.discordId);
  }
  return [...ids].sort();
}

async function resolveDiscordIds(discordIds, cache) {
  const positive = { ...cache.positive };
  const negativeUntil = { ...cache.negativeUntil };
  let lookedUp = 0;
  let reused = 0;
  let negativeHits = 0;
  let unlinked = 0;
  const now = Date.now();

  for (const discordId of discordIds) {
    if (positive[discordId]) {
      delete negativeUntil[discordId];
      reused += 1;
      continue;
    }
    if (negativeUntil[discordId] && negativeUntil[discordId] > now) {
      negativeHits += 1;
      continue;
    }
    // Small delay so a sudden jump in lookups does not burst the API.
    if (lookedUp > 0) await sleep(LOOKUP_GAP_MS);
    const robloxId = await lookupRobloxId(discordId);
    lookedUp += 1;
    if (robloxId) {
      positive[discordId] = robloxId;
      delete negativeUntil[discordId];
    } else {
      delete positive[discordId];
      negativeUntil[discordId] = Date.now() + NEGATIVE_LOOKUP_TTL_MS;
      unlinked += 1;
    }
  }

  return { positive, negativeUntil, lookedUp, reused, negativeHits, unlinked };
}

function pruneCache(positive, negativeUntil, activeIds) {
  const active = new Set(activeIds);
  const now = Date.now();
  for (const discordId of Object.keys(positive)) {
    if (!active.has(discordId)) delete positive[discordId];
  }
  for (const discordId of Object.keys(negativeUntil)) {
    if (!active.has(discordId) || negativeUntil[discordId] <= now) delete negativeUntil[discordId];
  }
}

function linkedBoosters(boosters, positive) {
  const resolved = [];
  for (const booster of boosters) {
    const robloxId = positive[booster.discordId];
    if (!robloxId) continue;
    resolved.push({ robloxId, since: booster.since });
  }
  return resolved;
}

function compareRoleIds(roleMap, a, b) {
  const pa = roleMap[a] ? roleMap[a].position : 0;
  const pb = roleMap[b] ? roleMap[b].position : 0;
  if (pa !== pb) return pb - pa;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function buildRolesPayload(roleMap, members, positive) {
  const roles = {};
  for (const id of Object.keys(roleMap).sort((a, b) => compareRoleIds(roleMap, a, b))) {
    roles[id] = roleMap[id];
  }

  const grouped = {};
  for (const member of members) {
    const robloxId = positive[member.discordId];
    if (!robloxId) continue;
    const kept = member.roleIds.filter((roleId) => Object.hasOwn(roleMap, roleId));
    if (kept.length === 0) continue;
    const key = String(robloxId);
    if (!grouped[key]) grouped[key] = new Set();
    for (const roleId of kept) grouped[key].add(roleId);
  }

  const membersOut = {};
  for (const id of Object.keys(grouped).sort((a, b) => Number(a) - Number(b))) {
    membersOut[id] = [...grouped[id]].sort((a, b) => compareRoleIds(roleMap, a, b));
  }

  return {
    updatedAt: new Date().toISOString(),
    roles,
    members: membersOut,
  };
}

function rolesSignature(value) {
  const roles =
    value && typeof value === "object" && value.roles && typeof value.roles === "object" ? value.roles : {};
  const members =
    value && typeof value === "object" && value.members && typeof value.members === "object" ? value.members : {};
  const rolePart = Object.keys(roles)
    .sort()
    .map((id) => {
      const role = roles[id] && typeof roles[id] === "object" ? roles[id] : {};
      const position = Number(role.position);
      return [String(id), String(role.name ?? ""), String(role.color ?? ""), Number.isFinite(position) ? position : 0];
    });
  const memberPart = Object.keys(members)
    .sort()
    .map((id) => {
      const list = Array.isArray(members[id]) ? members[id].map((roleId) => String(roleId)).sort() : [];
      return [String(id), list];
    });
  return JSON.stringify([rolePart, memberPart]);
}

function datastoreValueBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function assertDatastoreLimit(value, label) {
  const bytes = datastoreValueBytes(value);
  if (bytes > DATASTORE_VALUE_LIMIT_BYTES) {
    fail(
      `${label} is ${bytes} bytes, which is over the Roblox datastore limit of ${DATASTORE_VALUE_LIMIT_BYTES} bytes (4MB). ` +
        "Refusing to write so the existing entry stays intact."
    );
  }
  if (bytes > Math.floor(DATASTORE_VALUE_LIMIT_BYTES * 0.75)) {
    log(`${label} is ${bytes} bytes, over 75% of the 4MB datastore limit.`);
  }
  return bytes;
}

async function main() {
  requireSecrets();

  const { members, boosters } = await listDiscordGuild();
  const roleMap = await listDiscordRoles();
  const current = await getDatastoreEntry(BOOSTERS_KEY);
  const cacheEntry = await getDatastoreEntry(CACHE_KEY);
  const rolesEntry = await getDatastoreEntry(ROLES_KEY);
  const cache = normalizeCache(cacheEntry.value);
  const discordIds = collectDiscordIds(members, boosters, roleMap);
  const stats = await resolveDiscordIds(discordIds, cache);
  pruneCache(stats.positive, stats.negativeUntil, discordIds);

  const resolved = linkedBoosters(boosters, stats.positive);
  log(
    `Bloxlink: ${stats.lookedUp} lookup${stats.lookedUp === 1 ? "" : "s"}, ` +
      `${stats.reused} reused from cache, ` +
      `${stats.negativeHits} unlinked cache hit${stats.negativeHits === 1 ? "" : "s"}, ` +
      `${stats.unlinked} unlinked skipped, ` +
      `${resolved.length} linked booster${resolved.length === 1 ? "" : "s"}.`
  );

  if (cacheChanged(cacheEntry.value, stats.positive, stats.negativeUntil)) {
    await putDatastoreEntry(CACHE_KEY, cacheRecord(stats.positive, stats.negativeUntil));
    log("Datastore: lookup cache updated.");
  }

  const previous = currentBoosterList(current.value);
  const sameList = compareKey(previous) === compareKey(resolved);
  if (sameList && !current.missing) {
    log("Datastore: booster list unchanged, no write.");
  } else {
    const payload = {
      updatedAt: new Date().toISOString(),
      boosters: resolved
        .slice()
        .sort((a, b) => String(a.since).localeCompare(String(b.since)) || a.robloxId - b.robloxId),
    };
    await putDatastoreEntry(BOOSTERS_KEY, payload);
    log(
      `Datastore: wrote ${payload.boosters.length} booster${payload.boosters.length === 1 ? "" : "s"} to ${DATASTORE_NAME}/${BOOSTERS_KEY}.`
    );
  }

  const rolesPayload = buildRolesPayload(roleMap, members, stats.positive);
  const roleCount = Object.keys(rolesPayload.roles).length;
  const memberCount = Object.keys(rolesPayload.members).length;
  const sameRoles = rolesSignature(rolesEntry.value) === rolesSignature(rolesPayload);
  if (sameRoles && !rolesEntry.missing) {
    const bytes = datastoreValueBytes(rolesPayload);
    if (bytes > DATASTORE_VALUE_LIMIT_BYTES) {
      log(
        `Datastore: Discord roles unchanged, but the entry is ${bytes} bytes, over the 4MB datastore limit.`
      );
    } else {
      log(
        `Datastore: Discord roles unchanged, no write (${roleCount} roles, ${memberCount} linked members, ${bytes} bytes).`
      );
    }
    return;
  }

  const bytes = assertDatastoreLimit(rolesPayload, "Discord roles entry");
  await putDatastoreEntry(ROLES_KEY, rolesPayload);
  log(
    `Datastore: wrote ${roleCount} role${roleCount === 1 ? "" : "s"} and ${memberCount} linked member${memberCount === 1 ? "" : "s"} to ${DATASTORE_NAME}/${ROLES_KEY} (${bytes} bytes).`
  );
}

if (require.main === module) {
  main().catch((error) => {
    fail(error && error.message ? error.message : "Unexpected failure.");
  });
}

module.exports = {
  colorToHex,
  isExcludedRole,
  normalizeCache,
  cacheRecord,
  cacheChanged,
  collectDiscordIds,
  pruneCache,
  linkedBoosters,
  buildRolesPayload,
  rolesSignature,
  datastoreValueBytes,
  DATASTORE_VALUE_LIMIT_BYTES,
  NEGATIVE_LOOKUP_TTL_MS,
};
