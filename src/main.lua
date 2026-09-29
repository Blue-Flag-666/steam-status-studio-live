local millennium = require("millennium")
local logger = require("logger")
-- Millennium exposes lua-cjson under the "json" preload name.
local cjson = require("json")
local has_http, http = pcall(require, "http")

local appdata = os.getenv("APPDATA")
local base = appdata and (appdata .. "\\SteamStatusStudio") or nil
local config_path = base and (base .. "\\config.json") or nil
local ids_path = base and (base .. "\\live-shortcuts.json") or nil
local cleanup_path = base and (base .. "\\manual-cleanup.json") or nil
local runner_path = base and (base .. "\\runner\\SteamStatusRunner.exe") or nil
local heartbeat_path = base and (base .. "\\runner\\SteamStatusRunner.heartbeat") or nil
local stop_path = base and (base .. "\\runner\\SteamStatusRunner.stop") or nil
local write_sequence = 0
local miniprofile_cache = {}

---@ffi
---@param account_id string
---@return string
function getPublicMiniProfile(account_id)
    if type(account_id) ~= "string" or not account_id:match("^%d+$") or
       #account_id > 10 or tonumber(account_id) < 1 or tonumber(account_id) > 4294967295 then
        error("Invalid Steam account ID")
    end
    local cached = miniprofile_cache[account_id]
    if cached and cached.expires > os.time() then return cached.body end
    if not has_http then error("Millennium HTTP module is unavailable") end
    local response, request_error = http.get("https://steam-chat.com/miniprofile/" .. account_id .. "/json/", {
        timeout = 4,
        user_agent = "Mozilla/5.0 SteamStatusStudioLive/1.0"
    })
    if not response then error("Steam miniprofile request failed: " .. tostring(request_error)) end
    if response.status ~= 200 then error("Steam miniprofile returned HTTP " .. tostring(response.status)) end
    if type(response.body) ~= "string" or #response.body > 20000 then error("Invalid Steam miniprofile response") end
    local ok, parsed = pcall(cjson.decode, response.body)
    if not ok or type(parsed) ~= "table" then error("Invalid Steam miniprofile JSON") end
    miniprofile_cache[account_id] = { body = response.body, expires = os.time() + 120 }
    return response.body
end

local function read_file(path)
    if not path then return nil end
    local file = io.open(path, "rb")
    if not file then return nil end
    local data = file:read("*a")
    file:close()
    return data
end

local function decode_file(path, fallback)
    local raw = read_file(path)
    if not raw then
        raw = read_file(path .. ".steamstatus-live.bak")
        if not raw then return fallback end
    end
    local function decode(data)
        data = data:gsub("^\239\187\191", "") -- Windows PowerShell 5.1 UTF-8 BOM
        local ok, value = pcall(cjson.decode, data)
        if ok and type(value) == "table" then return value end
        return nil
    end
    local value = decode(raw)
    if value then return value end
    local backup = read_file(path .. ".steamstatus-live.bak")
    if backup then
        value = decode(backup)
        if value then return value end
    end
    error("Cannot read " .. path .. ": invalid JSON (including backup)")
end

local function write_file(path, value)
    if not path then error("APPDATA is unavailable") end
    local temporary = path .. ".steamstatus-live.tmp"
    local backup = path .. ".steamstatus-live.bak"
    local encoded = cjson.encode(value)
    local file = assert(io.open(temporary, "wb"))
    assert(file:write(encoded))
    assert(file:close())
    local ok, decoded = pcall(cjson.decode, assert(read_file(temporary)))
    if not ok or type(decoded) ~= "table" then error("Cannot validate " .. temporary) end

    local old = read_file(path)
    local previous_path = nil
    if old then
        local valid_old, old_value = pcall(cjson.decode, (old:gsub("^\239\187\191", "")))
        if valid_old and type(old_value) == "table" then
            local removed, message = os.remove(backup)
            if not removed and read_file(backup) then
                error("Cannot rotate backup " .. backup .. ": " .. tostring(message))
            end
            previous_path = backup
        else
            -- Keep both the valid backup and the damaged original recoverable.
            write_sequence = write_sequence + 1
            previous_path = path .. ".steamstatus-live.corrupt." .. os.time() .. "." .. write_sequence
        end
        -- A crash between renames is recovered by decode_file reading backup.
        local moved, message = os.rename(path, previous_path)
        if not moved then error("Cannot back up " .. path .. ": " .. tostring(message)) end
    end
    local moved, message = os.rename(temporary, path)
    if not moved then
        if previous_path then os.rename(previous_path, path) end
        error("Cannot replace " .. path .. ": " .. tostring(message))
    end
end

local function remove_if_present(path)
    if not read_file(path) then return end
    local removed, message = os.remove(path)
    if not removed then error("Cannot remove " .. path .. ": " .. tostring(message)) end
end

local function default_config()
    return {
        Version = 1,
        SelectedAccount = "",
        SelectedProfile = "default",
        Profiles = {{ Id = "default", Text = "Taking it easy", CreatedAt = "" }}
    }
end

local function valid_text(value)
    if type(value) ~= "string" or value:match("^%s*$") or value:find("[%z\1-\31]") then return false end
    local count = 0
    for i = 1, #value do
        local byte = value:byte(i)
        if byte < 128 or byte >= 192 then count = count + 1 end
    end
    return count <= 80
end

local function get_config()
    local config = decode_file(config_path, default_config())
    if type(config.Profiles) ~= "table" or #config.Profiles == 0 or #config.Profiles > 100 then
        error("config.json 中的状态模板数量须为 1–100；原文件未被修改")
    end
    local seen = {}
    local selected_found = false
    for index, profile in ipairs(config.Profiles) do
        if type(profile) ~= "table" or type(profile.Id) ~= "string" or
           not profile.Id:match("^[%w%-]+$") or #profile.Id > 80 or
           not valid_text(profile.Text) or seen[profile.Id] then
            error("config.json 中第 " .. index .. " 个状态模板无效；原文件未被修改")
        end
        seen[profile.Id] = true
        if profile.Id == config.SelectedProfile then selected_found = true end
    end
    if not selected_found then config.SelectedProfile = config.Profiles[1].Id end
    return config
end

---@ffi
---@return table
function getRecoveryInfo()
    if not base then error("APPDATA is unavailable") end
    local ids_ok, ids = pcall(decode_file, ids_path, {})
    local manual_ok, manual = pcall(decode_file, cleanup_path, {})
    return {
        shortcutIds = ids_ok and ids or nil,
        manualCleanup = manual_ok and manual or {},
        cleanupUnreadable = not manual_ok
    }
end

---@ffi
---@return table
function getBootstrap()
    if not base then error("APPDATA is unavailable") end
    return {
        config = get_config(),
        shortcutIds = decode_file(ids_path, {}),
        manualCleanup = decode_file(cleanup_path, {}),
        persistentCleanup = true,
        runnerPath = runner_path,
        runnerReady = read_file(runner_path) ~= nil,
        executable = runner_path,
        startDir = base .. "\\runner",
        launchOptions = ""
    }
end

---@ffi
---@return boolean
function isRunnerActive()
    local heartbeat = read_file(heartbeat_path)
    if not heartbeat then return false end
    local pid, milliseconds = heartbeat:match("^(%d+):(%d+)$")
    if not pid or not milliseconds then return false end
    local age = math.abs(os.time() * 1000 - tonumber(milliseconds))
    return age <= 4000
end

---@ffi
---@return boolean
function requestRunnerStop()
    if not stop_path then error("APPDATA is unavailable") end
    local file = assert(io.open(stop_path, "wb"))
    assert(file:write("stop"))
    assert(file:close())
    return true
end

---@ffi
---@param json string
---@return table
function saveTemplates(json)
    if type(json) ~= "string" then error("Invalid template data") end
    local ok, input = pcall(cjson.decode, json)
    if not ok or type(input) ~= "table" or type(input.Profiles) ~= "table" then error("Invalid template JSON") end
    if #input.Profiles < 1 or #input.Profiles > 100 then error("Keep between 1 and 100 templates") end
    local selected_found = false
    local seen = {}
    for _, profile in ipairs(input.Profiles) do
        if type(profile) ~= "table" or type(profile.Id) ~= "string" or
           not profile.Id:match("^[%w%-]+$") or #profile.Id > 80 or
           not valid_text(profile.Text) or seen[profile.Id] then
            error("Invalid template ID or text")
        end
        seen[profile.Id] = true
        if profile.Id == input.SelectedProfile then selected_found = true end
    end
    if not selected_found then error("Selected template does not exist") end
    local current = get_config()
    current.Profiles = input.Profiles
    current.SelectedProfile = input.SelectedProfile
    write_file(config_path, current)
    return current
end

---@ffi
---@param account_id string
---@return table|nil
function getShortcutId(account_id)
    account_id = tostring(account_id)
    if not account_id:match("^%d+$") then error("Invalid Steam account") end
    return decode_file(ids_path, {})[account_id]
end

---@ffi
---@param account_id string
---@param app_id number
---@param name string
---@param runner boolean
---@return boolean
function setShortcutId(account_id, app_id, name, runner)
    account_id = tostring(account_id)
    if not account_id:match("^%d+$") or type(app_id) ~= "number" or
       app_id < 2147483648 or app_id > 4294967295 or app_id % 1 ~= 0 or
       not valid_text(name) or type(runner) ~= "boolean" then
        error("Invalid Steam account or shortcut ID")
    end
    local ids = decode_file(ids_path, {})
    if ids[account_id] and ids[account_id].id ~= app_id then
        error("A different shortcut is already recorded for this account")
    end
    ids[account_id] = { id = app_id, name = name, runner = runner }
    write_file(ids_path, ids)
    return true
end

---@ffi
---@param account_id string
---@return boolean
function clearShortcutId(account_id)
    account_id = tostring(account_id)
    if not account_id:match("^%d+$") then error("Invalid Steam account") end
    local ids = decode_file(ids_path, {})
    ids[account_id] = nil
    write_file(ids_path, ids)
    return true
end

local function valid_cleanup_item(item)
    return type(item) == "table" and type(item.account) == "string" and
           #item.account <= 20 and type(item.reason) == "string" and
           #item.reason <= 500 and
           (item.id == nil or (type(item.id) == "number" and item.id % 1 == 0)) and
           (item.name == nil or (type(item.name) == "string" and #item.name <= 400))
end

---@ffi
---@param item_json string
---@return table
function addManualCleanup(item_json)
    if not base then error("APPDATA is unavailable") end
    if type(item_json) ~= "string" then error("Invalid cleanup report") end
    local ok, item = pcall(cjson.decode, item_json)
    if not ok or not valid_cleanup_item(item) or item.id == nil then error("Invalid cleanup report") end
    local manual = decode_file(cleanup_path, {})
    if type(manual) ~= "table" or #manual > 100 then error("Invalid existing cleanup report") end
    for index, existing in ipairs(manual) do
        if existing.account == item.account and existing.id == item.id then
            manual[index] = item
            write_file(cleanup_path, manual)
            return manual
        end
    end
    if #manual >= 100 then error("Too many cleanup reports") end
    manual[#manual + 1] = item
    write_file(cleanup_path, manual)
    return manual
end

---@ffi
---@param manual_json string
---@return table
function resetPluginData(manual_json)
    if not base then error("APPDATA is unavailable") end
    if type(manual_json) ~= "string" then error("Invalid cleanup report") end
    local ok, manual = pcall(cjson.decode, manual_json)
    if not ok or type(manual) ~= "table" or #manual > 100 then
        error("Invalid cleanup report")
    end
    for _, item in ipairs(manual) do
        if not valid_cleanup_item(item) then error("Invalid cleanup report") end
    end
    -- Preserve unresolved manual cleanup guidance before shortcut IDs vanish.
    write_file(cleanup_path, manual)
    -- Reset the configuration first. If that write fails, shortcut IDs remain
    -- available for a later retry or manual recovery.
    local config = default_config()
    local had_config = read_file(config_path) or read_file(config_path .. ".steamstatus-live.bak")
    local had_ids = read_file(ids_path) or read_file(ids_path .. ".steamstatus-live.bak")
    if had_config or had_ids then
        write_file(config_path, config)
        write_file(ids_path, {})
        -- Old backups must not resurrect pre-reset templates or shortcut IDs.
        remove_if_present(config_path .. ".steamstatus-live.bak")
        remove_if_present(ids_path .. ".steamstatus-live.bak")
    end
    return { config = config, shortcutIds = {}, manualCleanup = manual }
end

---@ffi
---@return boolean
function clearManualCleanup()
    if not base then error("APPDATA is unavailable") end
    write_file(cleanup_path, {})
    remove_if_present(cleanup_path .. ".steamstatus-live.bak")
    return true
end

local function on_load()
    logger:info("Steam Status Studio Live backend loaded")
    -- A new Steam session must not resume an old playing status. The runner
    -- exits on this request, while its shortcut and last applied name remain.
    if isRunnerActive() then
        local ok, err = pcall(requestRunnerStop)
        if not ok then logger:error("Could not stop previous status: " .. tostring(err)) end
    end
    millennium.ready()
end

return { on_load = on_load }
