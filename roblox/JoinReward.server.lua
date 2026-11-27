-- JoinReward.server.lua
-- Place this in ServerScriptService.
--
-- Grants a one-time Discord join reward when the player's Roblox account
-- is a Bloxlink-linked member of the Monovault Discord:
--   1 cosmetic, 250 Samples, 3 emotes
--
-- Membership comes from the SupporterWall datastore key "roles" written by
-- the GitHub booster-sync job (and optionally by the Monovault Ops bot).
-- A player is a member when their Roblox user id is a key in roles.members,
-- even if that list of Discord role ids is empty.
--
-- The claimed flag lives in a separate datastore (JoinReward) so the reward
-- cannot be granted twice. Leaving the Discord later does not take the
-- reward away.
--
-- If the player is not on the list, they see a message telling them to join
-- the Discord, verify with Bloxlink, then rejoin or press Recheck.
--
-- =============================================================================
-- THINGS YOU MUST FILL IN (search for PLACEHOLDER)
-- =============================================================================
-- 1) grantSamples, grantCosmetic, grantEmotes
--    Hook these up to Overgrowth's real inventory / currency code. This file
--    does not know how Samples, cosmetics, or emotes are stored.
--
-- 2) COSMETIC_ID and EMOTE_IDS
--    Replace the placeholder ids with the real item ids or names.
--
-- 3) Optional: StarterPlayer > StarterPlayerScripts > JoinRewardPrompt
--    The companion LocalScript in this folder. It shows the claim / how-to
--    message and a Recheck button. The reward still grants without it; the
--    player just will not see the on-screen prompt.
-- =============================================================================

local DataStoreService = game:GetService("DataStoreService")
local MessagingService = game:GetService("MessagingService")
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local ServerStorage = game:GetService("ServerStorage")

local MEMBER_DATASTORE_NAME = "SupporterWall"
local MEMBER_DATASTORE_KEY = "roles"
local CLAIM_DATASTORE_NAME = "JoinReward"

local SAMPLE_AMOUNT = 250
local EMOTE_COUNT = 3
local DISCORD_INVITE = "https://discord.com/invite/rHr9GxNrHN"

-- Set this to true only after grantSamples / grantCosmetic / grantEmotes
-- call the real Overgrowth systems (or to test the prompt on a test account).
-- While this is false, membership is still checked and unlinked players are
-- prompted, but nobody's claim flag is written and no items are granted.
local PLACEHOLDERS_READY = false

-- PLACEHOLDER: replace with the real cosmetic and emote ids or names.
local COSMETIC_ID = "DISCORD_JOIN_COSMETIC" -- e.g. a shop item id
local EMOTE_IDS = {
	"DISCORD_JOIN_EMOTE_1",
	"DISCORD_JOIN_EMOTE_2",
	"DISCORD_JOIN_EMOTE_3",
}

local FETCH_GAP_SECONDS = 10
local CLAIM_LEASE_SECONDS = 60
local MESSAGE_TOPIC = "JoinRewardMember"

local memberStore = DataStoreService:GetDataStore(MEMBER_DATASTORE_NAME)
local claimStore = DataStoreService:GetDataStore(CLAIM_DATASTORE_NAME)

local members = {} -- [userId string] = true
local lastFetchClock = 0
local refreshRunning = false

local function getOrCreateRemote(className, name)
	local existing = ReplicatedStorage:FindFirstChild(name)
	if existing and not existing:IsA(className) then
		existing:Destroy()
		existing = nil
	end
	if not existing then
		existing = Instance.new(className)
		existing.Name = name
		existing.Parent = ReplicatedStorage
	end
	return existing
end

local notify = getOrCreateRemote("RemoteEvent", "JoinRewardNotify")
local recheckFn = getOrCreateRemote("RemoteFunction", "JoinRewardRecheck")

local function isMember(userId)
	if userId == nil then
		return false
	end
	if members[tostring(userId)] == true then
		return true
	end
	-- Prefer the live DiscordRoles snapshot when that script is in the game.
	local check = ServerStorage:FindFirstChild("IsMonovaultMember")
	if check and check:IsA("BindableFunction") then
		local player = Players:GetPlayerByUserId(userId)
		if player then
			local ok, result = pcall(function()
				return check:Invoke(player)
			end)
			if ok and result == true then
				return true
			end
		end
	end
	return false
end

local function normalizeMembers(data)
	local nextMembers = {}
	if typeof(data) ~= "table" or typeof(data.members) ~= "table" then
		return nextMembers
	end
	for userId, _ in pairs(data.members) do
		nextMembers[tostring(userId)] = true
	end
	return nextMembers
end

local function refreshMembers(force)
	if refreshRunning then
		while refreshRunning do
			task.wait(0.05)
		end
		return true
	end
	if not force and (os.clock() - lastFetchClock) < FETCH_GAP_SECONDS then
		return true
	end

	refreshRunning = true
	local ok, err = pcall(function()
		local data = memberStore:GetAsync(MEMBER_DATASTORE_KEY)
		members = normalizeMembers(data)
		lastFetchClock = os.clock()
	end)
	refreshRunning = false
	if not ok then
		warn("[JoinReward] Could not read Discord membership: " .. tostring(err))
		return false
	end
	return true
end

local function markMember(userId)
	if userId == nil then
		return
	end
	members[tostring(userId)] = true
end

-- =============================================================================
-- PLACEHOLDER GRANT FUNCTIONS
-- Replace the body of each function with a call into Overgrowth's own systems.
-- A pending claim flag is written first so two servers cannot both grant.
-- If a grant fails after that, granted stays false and the next join retries.
-- =============================================================================

local function grantSamples(player, amount)
	-- PLACEHOLDER: add `amount` Samples to this player.
	-- Example, if you have a currency module:
	--   Currency:Add(player, "Samples", amount)
	-- Example, if Samples live in a player DataStore or attribute:
	--   local current = player:GetAttribute("Samples") or 0
	--   player:SetAttribute("Samples", current + amount)
	--   -- and persist however the rest of the game already saves currency
	warn(string.format("[JoinReward] PLACEHOLDER grantSamples: would give %s %d Samples", player.Name, amount))
	return true
end

local function grantCosmetic(player, cosmeticId)
	-- PLACEHOLDER: unlock the join-reward cosmetic for this player.
	-- Example:
	--   Inventory:UnlockCosmetic(player, cosmeticId)
	warn(string.format("[JoinReward] PLACEHOLDER grantCosmetic: would give %s cosmetic %s", player.Name, tostring(cosmeticId)))
	return true
end

local function grantEmotes(player, emoteIds)
	-- PLACEHOLDER: unlock the three join-reward emotes for this player.
	-- Example:
	--   for _, emoteId in ipairs(emoteIds) do
	--       Inventory:UnlockEmote(player, emoteId)
	--   end
	warn(string.format("[JoinReward] PLACEHOLDER grantEmotes: would give %s %d emotes", player.Name, #emoteIds))
	return true
end

-- =============================================================================

local function isFullyGranted(record)
	return typeof(record) == "table" and record.claimed == true and record.granted == true
end

local function isPendingClaim(record)
	return typeof(record) == "table" and record.claimed == true and record.granted ~= true
end

local function leaseExpired(record)
	if typeof(record) ~= "table" or typeof(record.leaseUntil) ~= "number" then
		return true
	end
	return record.leaseUntil <= os.time()
end

local function runGrant(fn, player, ...)
	local ok, result = pcall(fn, player, ...)
	if not ok then
		return false, tostring(result)
	end
	if result == false then
		return false, "grant function returned false"
	end
	return true
end

local function grantAll(player)
	local ok, err = runGrant(grantSamples, player, SAMPLE_AMOUNT)
	if not ok then
		return false, "samples: " .. err
	end
	ok, err = runGrant(grantCosmetic, player, COSMETIC_ID)
	if not ok then
		return false, "cosmetic: " .. err
	end
	ok, err = runGrant(grantEmotes, player, EMOTE_IDS)
	if not ok then
		return false, "emotes: " .. err
	end
	return true
end

local function newClaimRecord(granted, lastError)
	return {
		claimed = true,
		granted = granted == true,
		claimedAt = os.time(),
		leaseUntil = os.time() + CLAIM_LEASE_SECONDS,
		samples = SAMPLE_AMOUNT,
		cosmeticId = COSMETIC_ID,
		emoteIds = EMOTE_IDS,
		emoteCount = EMOTE_COUNT,
		lastError = lastError,
	}
end

local function tell(player, kind, text)
	if not player or not player.Parent then
		return
	end
	notify:FireClient(player, {
		kind = kind,
		text = text,
		invite = DISCORD_INVITE,
		showRecheck = kind == "howto",
	})
end

local HOWTO_TEXT = "Join the Monovault Discord and verify with Bloxlink to claim a free cosmetic, 250 Samples, and 3 emotes. Then rejoin the game or press Recheck."
local SUCCESS_TEXT = "Thanks for joining the Monovault Discord. You got a cosmetic, 250 Samples, and 3 emotes."

-- Returns: "granted" | "already" | "unlinked" | "error"
local function tryClaim(player, forceRefresh)
	if typeof(player) ~= "Instance" or not player:IsA("Player") then
		return "error"
	end

	refreshMembers(forceRefresh == true)

	local key = "u" .. tostring(player.UserId)

	if not isMember(player.UserId) then
		-- If a previous session reserved a claim but never finished granting,
		-- still let this session retry the grant even if they later left Discord.
		local existing
		local okRead, readErr = pcall(function()
			existing = claimStore:GetAsync(key)
		end)
		if okRead and isPendingClaim(existing) then
			-- fall through to the claim path below
		else
			if not okRead then
				warn("[JoinReward] Could not read claim flag for " .. player.Name .. ": " .. tostring(readErr))
				return "error"
			end
			return "unlinked"
		end
	end

	if not PLACEHOLDERS_READY then
		warn("[JoinReward] PLACEHOLDERS_READY is false. Hook up the grant functions, then set it to true. Not writing a claim for " .. player.Name)
		return "notready"
	end

	-- Reserve the claim before granting so two game servers cannot both pay out.
	-- The UpdateAsync callback may run more than once; only the last assignment
	-- of `state` is used. A short lease stops a second server from retrying a
	-- pending grant while the first one is still working.
	local state = "error"
	local okReserve, reserveErr = pcall(function()
		claimStore:UpdateAsync(key, function(old)
			if isFullyGranted(old) then
				state = "already"
				return old
			end
			if isPendingClaim(old) and not leaseExpired(old) then
				state = "busy"
				return old
			end
			if isPendingClaim(old) then
				state = "pending"
				old.leaseUntil = os.time() + CLAIM_LEASE_SECONDS
				return old
			end
			state = "reserved"
			return newClaimRecord(false, nil)
		end)
	end)
	if not okReserve then
		warn("[JoinReward] Could not reserve claim for " .. player.Name .. ": " .. tostring(reserveErr))
		return "error"
	end
	if state == "already" then
		return "already"
	end
	if state == "busy" then
		return "error"
	end
	if state ~= "reserved" and state ~= "pending" then
		return "error"
	end

	local grantedOk, grantErr = grantAll(player)
	if not grantedOk then
		warn("[JoinReward] Grant failed for " .. player.Name .. ": " .. tostring(grantErr))
		pcall(function()
			claimStore:UpdateAsync(key, function(old)
				if isFullyGranted(old) then
					return old
				end
				local record = newClaimRecord(false, tostring(grantErr))
				if typeof(old) == "table" and typeof(old.claimedAt) == "number" then
					record.claimedAt = old.claimedAt
				end
				return record
			end)
		end)
		return "error"
	end

	local marked = false
	local okWrite, writeErr = pcall(function()
		claimStore:UpdateAsync(key, function(old)
			if isFullyGranted(old) then
				marked = true
				return old
			end
			marked = true
			local record = newClaimRecord(true, nil)
			if typeof(old) == "table" and typeof(old.claimedAt) == "number" then
				record.claimedAt = old.claimedAt
			end
			record.leaseUntil = nil
			return record
		end)
	end)
	if not okWrite then
		warn("[JoinReward] Granted items but could not mark claimed for " .. player.Name .. ": " .. tostring(writeErr))
		return "error"
	end
	if not marked then
		return "error"
	end
	return "granted"
end

local function handlePlayer(player, forceRefresh)
	local result = tryClaim(player, forceRefresh)
	if result == "granted" then
		tell(player, "success", SUCCESS_TEXT)
	elseif result == "unlinked" then
		tell(player, "howto", HOWTO_TEXT)
	elseif result == "error" then
		tell(player, "error", "Couldn't check the Discord reward right now. Try Recheck in a moment.")
	end
	-- "already" and "notready" stay quiet so returning players, and a game
	-- that does not have the grants wired yet, are not prompted every join.
	return result
end

recheckFn.OnServerInvoke = function(player)
	return handlePlayer(player, true)
end

Players.PlayerAdded:Connect(function(player)
	task.spawn(handlePlayer, player, false)
end)

for _, player in ipairs(Players:GetPlayers()) do
	task.spawn(handlePlayer, player, false)
end

local okSubscribe, subscribeErr = pcall(function()
	MessagingService:SubscribeAsync(MESSAGE_TOPIC, function(message)
		local data = message and message.Data
		local userId = nil
		if typeof(data) == "number" then
			userId = data
		elseif typeof(data) == "string" then
			userId = tonumber(data)
			if not userId then
				local ok, parsed = pcall(function()
					return game:GetService("HttpService"):JSONDecode(data)
				end)
				if ok and typeof(parsed) == "table" then
					userId = tonumber(parsed.robloxId or parsed.userId)
				end
			end
		elseif typeof(data) == "table" then
			userId = tonumber(data.robloxId or data.userId)
		end
		if not userId then
			return
		end
		markMember(userId)
		local player = Players:GetPlayerByUserId(userId)
		if player then
			task.spawn(handlePlayer, player, false)
		end
	end)
end)
if not okSubscribe then
	warn("[JoinReward] MessagingService subscribe failed (optional): " .. tostring(subscribeErr))
end
