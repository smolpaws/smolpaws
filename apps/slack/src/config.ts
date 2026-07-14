function parseSet(value: string | undefined): Set<string> {
  if (!value) return new Set();
  return new Set(value.split(',').map((s) => s.trim()).filter(Boolean));
}

export type SlackConfig = {
  botToken: string;
  appToken: string;
  allowedTeamIds: Set<string>;
  allowedChannelIds: Set<string>;
  allowedUserIds: Set<string>;
  logLevel: string;
};

export function loadConfig(env: Record<string, string | undefined> = process.env): SlackConfig {
  const botToken = env.SLACK_BOT_TOKEN?.trim();
  const appToken = env.SLACK_APP_TOKEN?.trim();

  if (!botToken) throw new Error('SLACK_BOT_TOKEN is required');
  if (!appToken) throw new Error('SLACK_APP_TOKEN is required');

  return {
    botToken,
    appToken,
    allowedTeamIds: parseSet(env.SLACK_ALLOWED_TEAM_IDS),
    allowedChannelIds: parseSet(env.SLACK_ALLOWED_CHANNEL_IDS),
    allowedUserIds: parseSet(env.SLACK_ALLOWED_USER_IDS),
    logLevel: env.LOG_LEVEL || 'info',
  };
}
