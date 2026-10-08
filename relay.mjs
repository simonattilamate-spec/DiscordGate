// Mindkét platform bot- és webhooküzeneteit kihagyjuk a visszaküldési hurok ellen.
export function shouldForward(message, channelId, ownId) {
  return message.channelId === channelId &&
    Boolean(message.author) &&
    message.author.id !== ownId &&
    !message.author.bot &&
    !message.webhookId &&
    !message.system &&
    (message.type === undefined || [0, 19].includes(message.type));
}

export function snapshot(message, platform, channelName) {
  return {
    id: message.id,
    platform,
    source: message.channelId,
    guildId: message.guildId,
    authorId: message.author.id,
    author: message.member?.displayName || message.member?.nick || message.author.globalName || message.author.username,
    channel: channelName || message.channelId,
    createdAt: message.createdAt.toISOString(),
    content: message.content || '',
    displayContent: message.cleanContent || message.content || '',
    // A Fluxer SDK Message osztályának nincs url tulajdonsága.
    url: platform === 'Discord' ? message.url : '',
    attachments: [...message.attachments.values()].map(a => ({
      name: a.name || a.filename || 'Csatolmány', url: a.url, size: a.size,
    })),
  };
}
