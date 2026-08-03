export const regressionRedisDeleteOwnedPrimaryLua = `
    local actual = redis.call('HGET', KEYS[1], 'sessionAttr:jdy.username')
    if not actual then
      return redis.call('EXISTS', KEYS[1]) == 0 and 0 or -1
    end
    local actual_digest = redis.sha1hex(actual)
    for index = 1, #ARGV do
      if actual_digest == ARGV[index] then return redis.call('DEL', KEYS[1]) end
    end
    return -1
  `;

export const regressionRedisValueDigestLua = `
    local value_type = redis.call('TYPE', KEYS[1]).ok
    if value_type == 'none' then return '' end
    if value_type == 'hash' then
      local flat = redis.call('HGETALL', KEYS[1])
      local framed = {}
      for index = 1, #flat, 2 do
        local field = flat[index]
        local value = flat[index + 1]
        table.insert(framed, string.len(field) .. ':' .. field .. string.len(value) .. ':' .. value)
      end
      table.sort(framed)
      return redis.sha1hex(value_type .. ':' .. table.concat(framed, '|'))
    end
    local dumped = redis.call('DUMP', KEYS[1])
    return redis.sha1hex(value_type .. ':' .. dumped)
  `;
