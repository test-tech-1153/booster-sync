-- SupporterService.server.lua
-- Place this in ServerScriptService.
--
-- Reads the SupporterWall datastore (key "boosters") written by the GitHub
-- sync job, then:
--   1. Marks boosters with a Supporter overhead tag
--   2. Gives them the booster item, if you placed one
--   3. Fills the supporter wall, if you placed one
--
-- Other server scripts can check a player with:
--   ServerStorage.IsSupporter:Invoke(player)
-- Or just read the attribute:
--   player:GetAttribute("IsSupporter")
--
-- =============================================================================
-- THINGS YOU MUST PLACE YOURSELF
-- =============================================================================
-- 1) ServerStorage.SupporterItem
--    A Tool (or any instance) to clone into a booster's backpack.
--    If this is missing, the script warns once and skips the item.
--
-- 2) workspace.SupporterWall
--    A Model or Part in the world with a SurfaceGui on the front of the wall.
--    Recommended layout:
--
--      workspace.SupporterWall          -- Model or BasePart (you place this)
--        WallPart                       -- the visible wall, if you use a Model
--          SurfaceGui                   -- you place this, face it outward
--            Container                  -- optional Frame; created if missing
--            SlotTemplate               -- optional Frame to clone per booster
--              Avatar                   -- ImageLabel
--              Name                     -- TextLabel
--            List                       -- optional TextLabel fallback
--
--    If SlotTemplate exists, the script clones it once per booster and fills
--    Avatar + Name. If it does not, names are written into List (or a List
--    label is created for you).
--
-- 3) StarterPlayer > StarterPlayerScripts > SupporterChatTag
--    The companion LocalScript in this folder (SupporterChatTag.client.lua).
--    That is what adds the [Supporter] chat tag. Overhead tags still work
--    without it.
-- =============================================================================

local DataStoreService = game:GetService("DataStoreService")
local Players = game:GetService("Players")
local ServerStorage = game:GetService("ServerStorage")
local Workspace = game:GetService("Workspace")

local DATASTORE_NAME = "SupporterWall"
local DATASTORE_KEY = "boosters"
local REFRESH_SECONDS = 120
local MAX_BACKOFF_SECONDS = 600

local store = DataStoreService:GetDataStore(DATASTORE_NAME)

local supporterIds = {} -- [userId] = true
local nameCache = {} -- [userId] = username
local warnedMissingItem = false
local warnedMissingWall = false

local function isSupporter(player)
	return player ~= nil and supporterIds[player.UserId] == true
end

local checkFn = ServerStorage:FindFirstChild("IsSupporter")
if checkFn and not checkFn:IsA("BindableFunction") then
	checkFn:Destroy()
	checkFn = nil
end
if not checkFn then
	checkFn = Instance.new("BindableFunction")
	checkFn.Name = "IsSupporter"
	checkFn.Parent = ServerStorage
end
checkFn.OnInvoke = isSupporter

local function getPlayerName(userId)
	if nameCache[userId] then
		return nameCache[userId]
	end
	local ok, name = pcall(function()
		return Players:GetNameFromUserIdAsync(userId)
	end)
	if ok and typeof(name) == "string" and name ~= "" then
		nameCache[userId] = name
		return name
	end
	return "User " .. tostring(userId)
end

local function parseBoosters(data)
	local list = {}
	if typeof(data) ~= "table" or typeof(data.boosters) ~= "table" then
		return list
	end
	for _, row in ipairs(data.boosters) do
		if typeof(row) == "table" then
			local id = tonumber(row.robloxId)
			if id and id > 0 then
				table.insert(list, {
					robloxId = id,
					since = typeof(row.since) == "string" and row.since or "",
				})
			end
		end
	end
	table.sort(list, function(a, b)
		if a.since == b.since then
			return a.robloxId < b.robloxId
		end
		return a.since < b.since
	end)
	return list
end

local function listsEqual(a, b)
	if #a ~= #b then
		return false
	end
	for i = 1, #a do
		if a[i].robloxId ~= b[i].robloxId or a[i].since ~= b[i].since then
			return false
		end
	end
	return true
end

local function applySupporterAttribute(player)
	player:SetAttribute("IsSupporter", isSupporter(player) == true)
end

local function clearOverhead(character)
	local head = character:FindFirstChild("Head")
	if not head then
		return
	end
	local existing = head:FindFirstChild("SupporterTag")
	if existing then
		existing:Destroy()
	end
end

local function attachOverhead(character)
	local head = character:WaitForChild("Head", 10)
	if not head then
		return
	end
	clearOverhead(character)
	local gui = Instance.new("BillboardGui")
	gui.Name = "SupporterTag"
	gui.Size = UDim2.new(0, 120, 0, 28)
	gui.StudsOffset = Vector3.new(0, 2.4, 0)
	gui.AlwaysOnTop = false
	gui.MaxDistance = 80
	gui.Parent = head

	local label = Instance.new("TextLabel")
	label.Name = "Label"
	label.BackgroundTransparency = 1
	label.Size = UDim2.new(1, 0, 1, 0)
	label.Font = Enum.Font.GothamMedium
	label.Text = "Supporter"
	label.TextColor3 = Color3.fromRGB(201, 168, 76)
	label.TextStrokeTransparency = 0.4
	label.TextScaled = true
	label.Parent = gui
end

local function giveItem(player)
	local item = ServerStorage:FindFirstChild("SupporterItem")
	if not item then
		if not warnedMissingItem then
			warnedMissingItem = true
			warn("[SupporterService] ServerStorage.SupporterItem is missing. Place a Tool (or other instance) there to give boosters an item. Skipping the item until you do.")
		end
		return
	end
	if player.Backpack:FindFirstChild(item.Name) then
		return
	end
	if player.Character and player.Character:FindFirstChild(item.Name) then
		return
	end
	local clone = item:Clone()
	clone.Parent = player.Backpack
end

local function setupPlayer(player)
	applySupporterAttribute(player)
	if not isSupporter(player) then
		if player.Character then
			clearOverhead(player.Character)
		end
		return
	end
	giveItem(player)
	if player.Character then
		attachOverhead(player.Character)
	end
end

local function getWallGui()
	local wall = Workspace:FindFirstChild("SupporterWall")
	if not wall then
		return nil
	end
	local gui = wall:FindFirstChildWhichIsA("SurfaceGui", true)
	return gui
end

local function ensureContainer(gui)
	local container = gui:FindFirstChild("Container")
	if container and container:IsA("GuiObject") then
		return container
	end
	container = Instance.new("Frame")
	container.Name = "Container"
	container.BackgroundTransparency = 1
	container.Size = UDim2.new(1, -16, 1, -16)
	container.Position = UDim2.new(0, 8, 0, 8)
	container.Parent = gui
	local layout = Instance.new("UIListLayout")
	layout.FillDirection = Enum.FillDirection.Vertical
	layout.Padding = UDim.new(0, 6)
	layout.SortOrder = Enum.SortOrder.LayoutOrder
	layout.Parent = container
	return container
end

local function fillWall(boosters)
	local gui = getWallGui()
	if not gui then
		if not warnedMissingWall then
			warnedMissingWall = true
			warn("[SupporterService] workspace.SupporterWall (with a SurfaceGui) was not found. Place the wall in Workspace so boosters can appear on it.")
		end
		return
	end
	warnedMissingWall = false

	local template = gui:FindFirstChild("SlotTemplate", true)
	local listLabel = gui:FindFirstChild("List", true)

	if template and template:IsA("GuiObject") then
		local parent = template.Parent
		for _, child in ipairs(parent:GetChildren()) do
			if child:IsA("GuiObject") and child:GetAttribute("SupporterSlot") == true then
				child:Destroy()
			end
		end
		for index, row in ipairs(boosters) do
			local slot = template:Clone()
			slot.Name = "Supporter_" .. tostring(row.robloxId)
			slot.Visible = true
			slot.LayoutOrder = index
			slot:SetAttribute("SupporterSlot", true)
			local nameLabel = slot:FindFirstChild("Name", true)
			if nameLabel and nameLabel:IsA("TextLabel") then
				nameLabel.Text = getPlayerName(row.robloxId)
			end
			local avatar = slot:FindFirstChild("Avatar", true)
			if avatar and avatar:IsA("ImageLabel") then
				local ok, url = pcall(function()
					return Players:GetUserThumbnailAsync(
						row.robloxId,
						Enum.ThumbnailType.HeadShot,
						Enum.ThumbnailSize.Size150x150
					)
				end)
				if ok then
					avatar.Image = url
				end
			end
			slot.Parent = parent
		end
		template.Visible = false
		return
	end

	if not (listLabel and listLabel:IsA("TextLabel")) then
		local container = ensureContainer(gui)
		listLabel = container:FindFirstChild("List")
		if not (listLabel and listLabel:IsA("TextLabel")) then
			listLabel = Instance.new("TextLabel")
			listLabel.Name = "List"
			listLabel.BackgroundTransparency = 1
			listLabel.Size = UDim2.new(1, 0, 1, 0)
			listLabel.Font = Enum.Font.Gotham
			listLabel.TextColor3 = Color3.fromRGB(235, 235, 235)
			listLabel.TextStrokeTransparency = 0.5
			listLabel.TextXAlignment = Enum.TextXAlignment.Left
			listLabel.TextYAlignment = Enum.TextYAlignment.Top
			listLabel.TextWrapped = true
			listLabel.TextScaled = false
			listLabel.TextSize = 24
			listLabel.Parent = container
		end
	end

	if #boosters == 0 then
		listLabel.Text = "No supporters yet."
		return
	end

	local lines = { "Supporters" }
	for _, row in ipairs(boosters) do
		table.insert(lines, getPlayerName(row.robloxId))
	end
	listLabel.Text = table.concat(lines, "\n")
end

local function applyList(boosters)
	local nextIds = {}
	for _, row in ipairs(boosters) do
		nextIds[row.robloxId] = true
	end
	supporterIds = nextIds

	for _, player in ipairs(Players:GetPlayers()) do
		setupPlayer(player)
	end
	fillWall(boosters)
end

local lastList = nil
local function refresh()
	local data = store:GetAsync(DATASTORE_KEY)
	local boosters = parseBoosters(data)
	if lastList and listsEqual(lastList, boosters) then
		return true
	end
	lastList = boosters
	applyList(boosters)
	return true
end

local function refreshWithRetry()
	local backoff = REFRESH_SECONDS
	while true do
		local ok, err = pcall(refresh)
		if ok then
			backoff = REFRESH_SECONDS
			task.wait(REFRESH_SECONDS)
		else
			warn("[SupporterService] Could not read the supporter list: " .. tostring(err))
			backoff = math.min(backoff * 2, MAX_BACKOFF_SECONDS)
			task.wait(backoff)
		end
	end
end

Players.PlayerAdded:Connect(function(player)
	setupPlayer(player)
	player.CharacterAdded:Connect(function(character)
		applySupporterAttribute(player)
		if isSupporter(player) then
			giveItem(player)
			attachOverhead(character)
		else
			clearOverhead(character)
		end
	end)
end)

for _, player in ipairs(Players:GetPlayers()) do
	setupPlayer(player)
	if player.Character then
		if isSupporter(player) then
			attachOverhead(player.Character)
		end
	end
	player.CharacterAdded:Connect(function(character)
		applySupporterAttribute(player)
		if isSupporter(player) then
			giveItem(player)
			attachOverhead(character)
		else
			clearOverhead(character)
		end
	end)
end

task.spawn(refreshWithRetry)
