import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isDiscordMessageAllowed } from '../adapter.js';

const openGuildFilters = {
  allowedUserIds: new Set<string>(),
  allowedGuilds: new Set<string>(),
  allowedChannels: new Set<string>(),
};

describe('Discord authorization', () => {
  it('authorizes configured immutable account IDs', () => {
    assert.equal(isDiscordMessageAllowed(
      { userId: '123', guildId: 'guild', channelId: 'channel', isDirectMessage: false },
      { ...openGuildFilters, allowedUserIds: new Set(['123']) },
    ), true);
  });

  it('denies a different account ID regardless of display identity', () => {
    assert.equal(isDiscordMessageAllowed(
      { userId: '456', guildId: 'guild', channelId: 'channel', isDirectMessage: false },
      { ...openGuildFilters, allowedUserIds: new Set(['123']) },
    ), false);
  });

  it('keeps a renamed account authorized because its ID is stable', () => {
    assert.equal(isDiscordMessageAllowed(
      { userId: '123', guildId: null, channelId: 'dm', isDirectMessage: true },
      { ...openGuildFilters, allowedUserIds: new Set(['123']) },
    ), true);
  });

  it('preserves DM, guild, and channel filtering', () => {
    const filters = {
      allowedUserIds: new Set(['123']),
      allowedGuilds: new Set(['guild-a']),
      allowedChannels: new Set(['channel-a']),
    };
    assert.equal(isDiscordMessageAllowed(
      { userId: '123', guildId: null, channelId: 'dm', isDirectMessage: true }, filters,
    ), true);
    assert.equal(isDiscordMessageAllowed(
      { userId: '123', guildId: 'guild-b', channelId: 'channel-a', isDirectMessage: false }, filters,
    ), false);
    assert.equal(isDiscordMessageAllowed(
      { userId: '123', guildId: 'guild-a', channelId: 'channel-b', isDirectMessage: false }, filters,
    ), false);
    assert.equal(isDiscordMessageAllowed(
      { userId: '123', guildId: 'guild-a', channelId: 'channel-a', isDirectMessage: false }, filters,
    ), true);
  });
});
