-- DiscordRoles.server.lua
-- Place this in ServerScriptService.
--
-- Reads the SupporterWall datastore key "roles" written by the GitHub sync.
-- This script does not build any visuals. It only copies role data onto the
-- player so other game code can display it.
--
-- Datastore value:
--   {
--     updatedAt = "ISO-8601",
--     roles = { [discordRoleId] = { name, color, position } },
--     members = { [robloxUserId] = { discordRoleId, ... } },
--   }
-- color is "#rrggbb". position is the Discord position (higher ranks higher).
-- @everyone and managed bot roles are not included. The Server Booster role is.
--
-- On PlayerAdded, and about every 5 minutes, each player gets:
--   DiscordRoles    role names separated by a comma and a space, highest position first
--   DiscordTopRole  the highest role name, or "" when they have none
--
-- Other server scripts can call:
--   ServerStorage.GetDiscordRoles:Invoke(player)
-- which returns { { name, color, position }, ... } in that same order.

local DataStoreService = game:GetService("DataStoreService")
local Players = game:GetService("Players")
local ServerStorage = game:GetService("ServerStorage")

local DATASTORE_NAME = "SupporterWall"
local DATASTORE_KEY = "roles"
local REFRESH_SECONDS = 300

local store = DataStoreService:GetDataStore(DATASTORE_NAME)

local snapshot = {
	roles = {},
	members = {},
}
local refreshRunning = false

local function copyRoleList(list)
	local copy = {}
	for index, role in ipairs(list) do
		copy[index] = {
			name = role.name,
			color = role.color,
			position = role.position,
		}
	end
	return copy
end

local function normalize(data)
	local roles = {}
	local members = {}
	if typeof(data) ~= "table" then
		return { roles = roles, members = members }
	end

	if typeof(data.roles) == "table" then
		for roleId, role in pairs(data.roles) do
			if typeof(role) == "table" and typeof(role.name) == "string" then
				local position = tonumber(role.position) or 0
				roles[tostring(roleId)] = {
					name = role.name,
					color = typeof(role.color) == "string" and role.color or "#000000",
					position = position,
				}
			end
		end
	end

	if typeof(data.members) == "table" then
		for userId, roleIds in pairs(data.members) do
			if typeof(roleIds) == "table" then
				local list = {}
				for _, roleId in ipairs(roleIds) do
					table.insert(list, tostring(roleId))
				end
				members[tostring(userId)] = list
			end
		end
	end

	return { roles = roles, members = members }
end

local function rolesForUser(userId)
	local key = tostring(userId)
	local roleIds = snapshot.members[key]
	if not roleIds and typeof(userId) == "number" then
		roleIds = snapshot.members[userId]
	end
	if typeof(roleIds) ~= "table" then
		return {}
	end

	local list = {}
	for _, roleId in ipairs(roleIds) do
		local role = snapshot.roles[tostring(roleId)]
		if role then
			table.insert(list, {
				name = role.name,
				color = role.color,
				position = role.position,
			})
		end
	end

	table.sort(list, function(a, b)
		if a.position == b.position then
			return a.name < b.name
		end
		return a.position > b.position
	end)
	return list
end

local function apply(player)
	if typeof(player) ~= "Instance" or not player:IsA("Player") then
		return
	end
	local list = rolesForUser(player.UserId)
	local names = {}
	for _, role in ipairs(list) do
		table.insert(names, role.name)
	end
	local joined = table.concat(names, ", ")
	local top = ""
	if list[1] then
		top = list[1].name
	end
	if player:GetAttribute("DiscordRoles") ~= joined then
		player:SetAttribute("DiscordRoles", joined)
	end
	if player:GetAttribute("DiscordTopRole") ~= top then
		player:SetAttribute("DiscordTopRole", top)
	end
end

local function getDiscordRoles(player)
	if typeof(player) ~= "Instance" or not player:IsA("Player") then
		return {}
	end
	return copyRoleList(rolesForUser(player.UserId))
end

local function refresh()
	if refreshRunning then
		while refreshRunning do
			task.wait(0.05)
		end
		return
	end

	refreshRunning = true
	local ok, err = pcall(function()
		local data = store:GetAsync(DATASTORE_KEY)
		snapshot = normalize(data)
		for _, player in ipairs(Players:GetPlayers()) do
			apply(player)
		end
	end)
	refreshRunning = false
	if not ok then
		warn("[DiscordRoles] Could not read Discord roles: " .. tostring(err))
	end
end

local checkFn = ServerStorage:FindFirstChild("GetDiscordRoles")
if checkFn and not checkFn:IsA("BindableFunction") then
	checkFn:Destroy()
	checkFn = nil
end
if not checkFn then
	checkFn = Instance.new("BindableFunction")
	checkFn.Name = "GetDiscordRoles"
	checkFn.Parent = ServerStorage
end
checkFn.OnInvoke = getDiscordRoles

local function onPlayer(player)
	refresh()
	apply(player)
end

Players.PlayerAdded:Connect(onPlayer)

for _, player in ipairs(Players:GetPlayers()) do
	task.spawn(onPlayer, player)
end

task.spawn(function()
	while true do
		task.wait(REFRESH_SECONDS)
		refresh()
	end
end)
