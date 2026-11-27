-- JoinRewardPrompt.client.lua
-- Place this in StarterPlayer > StarterPlayerScripts.
--
-- Shows the Discord join-reward message and a Recheck button. Safe to skip;
-- the server still grants the reward without this script.

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local TweenService = game:GetService("TweenService")

local player = Players.LocalPlayer
local playerGui = player:WaitForChild("PlayerGui")

local notify = ReplicatedStorage:WaitForChild("JoinRewardNotify", 30)
local recheckFn = ReplicatedStorage:WaitForChild("JoinRewardRecheck", 30)
if not notify or not recheckFn then
	return
end

local gui = Instance.new("ScreenGui")
gui.Name = "JoinRewardPrompt"
gui.ResetOnSpawn = false
gui.IgnoreGuiInset = true
gui.ZIndexBehavior = Enum.ZIndexBehavior.Sibling
gui.Parent = playerGui

local frame = Instance.new("Frame")
frame.Name = "Card"
frame.AnchorPoint = Vector2.new(0.5, 1)
frame.Position = UDim2.new(0.5, 0, 1, -24)
frame.Size = UDim2.new(0, 420, 0, 132)
frame.BackgroundColor3 = Color3.fromRGB(16, 16, 18)
frame.BackgroundTransparency = 0.1
frame.Visible = false
frame.Parent = gui

local corner = Instance.new("UICorner")
corner.CornerRadius = UDim.new(0, 10)
corner.Parent = frame

local stroke = Instance.new("UIStroke")
stroke.Color = Color3.fromRGB(70, 70, 76)
stroke.Thickness = 1
stroke.Parent = frame

local padding = Instance.new("UIPadding")
padding.PaddingTop = UDim.new(0, 14)
padding.PaddingBottom = UDim.new(0, 14)
padding.PaddingLeft = UDim.new(0, 16)
padding.PaddingRight = UDim.new(0, 16)
padding.Parent = frame

local title = Instance.new("TextLabel")
title.Name = "Title"
title.BackgroundTransparency = 1
title.Position = UDim2.new(0, 0, 0, 0)
title.Size = UDim2.new(1, -24, 0, 20)
title.Font = Enum.Font.GothamMedium
title.Text = "Monovault Discord"
title.TextColor3 = Color3.fromRGB(235, 235, 235)
title.TextSize = 16
title.TextXAlignment = Enum.TextXAlignment.Left
title.Parent = frame

local close = Instance.new("TextButton")
close.Name = "Close"
close.BackgroundTransparency = 1
close.AnchorPoint = Vector2.new(1, 0)
close.Position = UDim2.new(1, 4, 0, -4)
close.Size = UDim2.new(0, 28, 0, 24)
close.Font = Enum.Font.GothamBold
close.Text = "×"
close.TextColor3 = Color3.fromRGB(180, 180, 180)
close.TextSize = 20
close.Parent = frame

local body = Instance.new("TextLabel")
body.Name = "Body"
body.BackgroundTransparency = 1
body.Position = UDim2.new(0, 0, 0, 24)
body.Size = UDim2.new(1, 0, 0, 52)
body.Font = Enum.Font.Gotham
body.Text = ""
body.TextColor3 = Color3.fromRGB(210, 210, 210)
body.TextSize = 14
body.TextWrapped = true
body.TextXAlignment = Enum.TextXAlignment.Left
body.TextYAlignment = Enum.TextYAlignment.Top
body.Parent = frame

local recheck = Instance.new("TextButton")
recheck.Name = "Recheck"
recheck.AnchorPoint = Vector2.new(0, 1)
recheck.Position = UDim2.new(0, 0, 1, 0)
recheck.Size = UDim2.new(0, 120, 0, 28)
recheck.BackgroundColor3 = Color3.fromRGB(201, 168, 76)
recheck.Font = Enum.Font.GothamMedium
recheck.Text = "Recheck"
recheck.TextColor3 = Color3.fromRGB(20, 20, 20)
recheck.TextSize = 14
recheck.Visible = false
recheck.Parent = frame

local recheckCorner = Instance.new("UICorner")
recheckCorner.CornerRadius = UDim.new(0, 6)
recheckCorner.Parent = recheck

local hideToken = 0

local function hide()
	hideToken += 1
	frame.Visible = false
end

local function show(kind, text, showRecheck)
	hideToken += 1
	local token = hideToken
	if kind == "success" then
		title.Text = "Reward claimed"
		title.TextColor3 = Color3.fromRGB(201, 168, 76)
	elseif kind == "error" then
		title.Text = "Discord reward"
		title.TextColor3 = Color3.fromRGB(235, 200, 120)
	else
		title.Text = "Monovault Discord"
		title.TextColor3 = Color3.fromRGB(235, 235, 235)
	end
	body.Text = text or ""
	recheck.Visible = showRecheck == true
	recheck.Text = "Recheck"
	recheck.Active = true
	frame.Visible = true
	frame.BackgroundTransparency = 0.3
	TweenService:Create(frame, TweenInfo.new(0.2), { BackgroundTransparency = 0.1 }):Play()

	local lifetime = (kind == "success") and 8 or 20
	task.delay(lifetime, function()
		if token == hideToken then
			hide()
		end
	end)
end

close.MouseButton1Click:Connect(hide)

recheck.MouseButton1Click:Connect(function()
	if not recheck.Active then
		return
	end
	recheck.Active = false
	recheck.Text = "Checking…"
	local ok, result = pcall(function()
		return recheckFn:InvokeServer()
	end)
	if not ok then
		show("error", "Couldn't check right now. Try again in a moment.", true)
		return
	end
	-- The server also fires JoinRewardNotify. If nothing comes back as a
	-- prompt (already claimed), just close.
	if result == "already" then
		hide()
	elseif result == "granted" or result == "unlinked" or result == "error" then
		-- notify handler will update the card
		recheck.Active = true
		recheck.Text = "Recheck"
	else
		hide()
	end
end)

notify.OnClientEvent:Connect(function(payload)
	if typeof(payload) ~= "table" then
		return
	end
	show(payload.kind, payload.text, payload.showRecheck == true)
end)
