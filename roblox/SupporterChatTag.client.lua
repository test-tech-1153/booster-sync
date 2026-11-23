-- Place this in StarterPlayer > StarterPlayerScripts.
-- Adds a [Supporter] prefix in chat for players the server marked with the
-- IsSupporter attribute. The server script sets that attribute.

local Players = game:GetService("Players")
local TextChatService = game:GetService("TextChatService")

TextChatService.OnIncomingMessage = function(message)
	local source = message.TextSource
	if not source then
		return nil
	end

	local player = Players:GetPlayerByUserId(source.UserId)
	if not player or not player:GetAttribute("IsSupporter") then
		return nil
	end

	local properties = Instance.new("TextChatMessageProperties")
	properties.PrefixText = "<font color='#c9a84c'>[Supporter]</font> " .. message.PrefixText
	return properties
end
