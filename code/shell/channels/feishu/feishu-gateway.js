import * as Lark from '@larksuiteoapi/node-sdk'

function parseMessageContent(rawContent) {
  if (typeof rawContent !== 'string' || rawContent.trim() === '') {
    return {
      raw: rawContent,
      parsed: null,
      text: null
    }
  }

  try {
    const parsed = JSON.parse(rawContent)

    return {
      raw: rawContent,
      parsed,
      text: typeof parsed.text === 'string' ? parsed.text : null
    }
  } catch {
    return {
      raw: rawContent,
      parsed: null,
      text: rawContent
    }
  }
}

function stringifyMessageContent(content) {
  if (typeof content === 'string') {
    return content
  }

  return JSON.stringify(content)
}

function uniqueValues(values = []) {
  return [...new Set(
    values
      .map((value) => (value == null ? null : String(value).trim()))
      .filter(Boolean)
  )]
}

function extractReferencedMessageIds({
  message = {},
  parsedContent = null
} = {}) {
  return uniqueValues([
    message.parent_id,
    message.parent_message_id,
    message.root_id,
    message.root_message_id,
    message.reply_to_message_id,
    message.reply_message_id,
    parsedContent?.parent_id,
    parsedContent?.parent_message_id,
    parsedContent?.root_id,
    parsedContent?.root_message_id,
    parsedContent?.reply_to_message_id,
    parsedContent?.reply_message_id,
    ...(Array.isArray(message.referenced_message_ids) ? message.referenced_message_ids : []),
    ...(Array.isArray(parsedContent?.referenced_message_ids) ? parsedContent.referenced_message_ids : [])
  ]).filter((messageId) => messageId !== message.message_id)
}

function normalizeIncomingEvent(eventEnvelope) {
  const event = eventEnvelope?.event ?? eventEnvelope ?? {}
  const message = event.message ?? {}
  const sender = event.sender ?? {}
  const senderId = sender.sender_id ?? {}
  const content = parseMessageContent(message.content ?? null)
  const referencedMessageIds = extractReferencedMessageIds({
    message,
    parsedContent: content.parsed
  })

  return {
    event_id: eventEnvelope?.header?.event_id ?? null,
    event_type: eventEnvelope?.header?.event_type ?? 'im.message.receive_v1',
    message_id: message.message_id ?? null,
    chat_id: message.chat_id ?? null,
    chat_type: message.chat_type ?? null,
    message_type: message.message_type ?? null,
    sender_open_id: senderId.open_id ?? null,
    sender_user_id: senderId.user_id ?? null,
    tenant_key: sender.tenant_key ?? null,
    text: content.text,
    content: content.parsed,
    raw_content: content.raw,
    parent_message_id: message.parent_id ?? message.parent_message_id ?? null,
    root_message_id: message.root_id ?? message.root_message_id ?? null,
    referenced_message_ids: referencedMessageIds,
    raw_event: eventEnvelope
  }
}

export function resolveFeishuConfig({
  appId = null,
  appSecret = null,
  encryptKey = null,
  verificationToken = null,
  domain = null
} = {}) {
  return {
    appId:
      appId ??
      process.env.NEWAGENT_FEISHU_APP_ID ??
      process.env.FEISHU_APP_ID ??
      null,
    appSecret:
      appSecret ??
      process.env.NEWAGENT_FEISHU_APP_SECRET ??
      process.env.FEISHU_APP_SECRET ??
      null,
    encryptKey:
      encryptKey ??
      process.env.NEWAGENT_FEISHU_ENCRYPT_KEY ??
      process.env.FEISHU_ENCRYPT_KEY ??
      null,
    verificationToken:
      verificationToken ??
      process.env.NEWAGENT_FEISHU_VERIFICATION_TOKEN ??
      process.env.FEISHU_VERIFICATION_TOKEN ??
      null,
    domain: domain ?? Lark.Domain.Feishu
  }
}

export function createFeishuApiClient({
  appId = null,
  appSecret = null,
  encryptKey = null,
  verificationToken = null,
  domain = null,
  sdk = Lark
} = {}) {
  const config = resolveFeishuConfig({
    appId,
    appSecret,
    encryptKey,
    verificationToken,
    domain
  })

  if (!config.appId || !config.appSecret) {
    throw new Error('Missing Feishu credentials. Set NEWAGENT_FEISHU_APP_ID and NEWAGENT_FEISHU_APP_SECRET.')
  }

  const baseConfig = {
    appId: config.appId,
    appSecret: config.appSecret,
    domain: config.domain,
    appType: sdk.AppType?.SelfBuild
  }

  return {
    config,
    baseConfig,
    client: new sdk.Client(baseConfig)
  }
}

export function describeFeishuChannelConfig(params = {}) {
  const config = resolveFeishuConfig(params)

  return {
    channel: 'feishu',
    connection_mode: 'long_connection',
    ready: Boolean(config.appId && config.appSecret),
    app_id_present: Boolean(config.appId),
    app_secret_present: Boolean(config.appSecret),
    encrypt_key_present: Boolean(config.encryptKey),
    verification_token_present: Boolean(config.verificationToken),
    domain: config.domain
  }
}

export function createFeishuGateway({
  appId = null,
  appSecret = null,
  encryptKey = null,
  verificationToken = null,
  domain = null,
  sdk = Lark
} = {}) {
  const config = resolveFeishuConfig({
    appId,
    appSecret,
    encryptKey,
    verificationToken,
    domain
  })

  if (!config.appId || !config.appSecret) {
    throw new Error('Missing Feishu credentials. Set NEWAGENT_FEISHU_APP_ID and NEWAGENT_FEISHU_APP_SECRET.')
  }

  const { baseConfig, client } = createFeishuApiClient({
    appId: config.appId,
    appSecret: config.appSecret,
    encryptKey: config.encryptKey,
    verificationToken: config.verificationToken,
    domain: config.domain,
    sdk
  })
  const wsClient = new sdk.WSClient({
    ...baseConfig,
    loggerLevel: sdk.LoggerLevel?.info
  })

  let started = false
  let lastEventAt = null
  const recentMessageIds = new Map()

  function pruneRecentMessageIds(now = Date.now()) {
    for (const [messageId, expiresAt] of recentMessageIds.entries()) {
      if (expiresAt <= now) {
        recentMessageIds.delete(messageId)
      }
    }
  }

  function markMessageSeen(messageId, now = Date.now()) {
    if (!messageId) {
      return false
    }

    pruneRecentMessageIds(now)

    if (recentMessageIds.has(messageId)) {
      return true
    }

    recentMessageIds.set(messageId, now + 5 * 60 * 1000)
    return false
  }

  async function sendTextMessage({
    receiveIdType = 'chat_id',
    receiveId,
    text
  }) {
    return sendMessage({
      receiveIdType,
      receiveId,
      msgType: 'text',
      content: {
        text
      }
    })
  }

  async function sendMessage({
    receiveIdType = 'chat_id',
    receiveId,
    msgType,
    content
  }) {
    if (!receiveId) {
      throw new Error('Missing required receiveId')
    }

    const response = await client.im.v1.message.create({
      params: {
        receive_id_type: receiveIdType
      },
      data: {
        receive_id: receiveId,
        content: stringifyMessageContent(content),
        msg_type: msgType
      }
    })

    return response
  }

  async function replyTextMessage({
    messageId,
    text
  }) {
    return replyMessage({
      messageId,
      msgType: 'text',
      content: {
        text
      }
    })
  }

  async function replyInteractiveCard({
    messageId,
    card
  }) {
    return replyMessage({
      messageId,
      msgType: 'interactive',
      content: card
    })
  }

  async function sendInteractiveCard({
    receiveIdType = 'chat_id',
    receiveId,
    card
  }) {
    return sendMessage({
      receiveIdType,
      receiveId,
      msgType: 'interactive',
      content: card
    })
  }

  async function replyMessage({
    messageId,
    msgType,
    content
  }) {
    if (!messageId) {
      throw new Error('Missing required messageId')
    }

    const response = await client.im.v1.message.reply({
      path: {
        message_id: messageId
      },
      data: {
        content: stringifyMessageContent(content),
        msg_type: msgType
      }
    })

    return response
  }

  async function updateTextMessage({
    messageId,
    text
  }) {
    return updateMessage({
      messageId,
      msgType: 'text',
      content: {
        text
      }
    })
  }

  async function updateMessage({
    messageId,
    msgType,
    content
  }) {
    if (!messageId) {
      throw new Error('Missing required messageId')
    }

    const response = await client.im.v1.message.update({
      path: {
        message_id: messageId
      },
      data: {
        content: stringifyMessageContent(content),
        msg_type: msgType
      }
    })

    return response
  }

  async function addMessageReaction({
    messageId,
    emojiType = 'SMILE'
  }) {
    if (!messageId) {
      throw new Error('Missing required messageId')
    }

    const response = await client.im.v1.messageReaction.create({
      path: {
        message_id: messageId
      },
      data: {
        reaction_type: {
          emoji_type: emojiType
        }
      }
    })

    return response
  }

  async function deleteMessageReaction({
    messageId,
    reactionId
  }) {
    if (!messageId) {
      throw new Error('Missing required messageId')
    }

    if (!reactionId) {
      throw new Error('Missing required reactionId')
    }

    const response = await client.im.v1.messageReaction.delete({
      path: {
        message_id: messageId,
        reaction_id: reactionId
      }
    })

    return response
  }

  async function listMessageReactions({
    messageId,
    reactionType = null,
    pageSize = 50
  }) {
    if (!messageId) {
      throw new Error('Missing required messageId')
    }

    const response = await client.im.v1.messageReaction.list({
      path: {
        message_id: messageId
      },
      params: {
        reaction_type: reactionType ?? undefined,
        page_size: pageSize
      }
    })

    return response
  }

  async function performImmediateAck({
    messageId,
    reactionEmojiType = null,
    replyText = null
  }) {
    if (!messageId) {
      return null
    }

    if (reactionEmojiType) {
      try {
        const response = await addMessageReaction({
          messageId,
          emojiType: reactionEmojiType
        })

        return {
          kind: 'reaction',
          ok: true,
          source: 'feishu_gateway',
          message_id: messageId,
          emoji_type: reactionEmojiType,
          reaction_id: response?.data?.reaction_id ?? null
        }
      } catch (reactionError) {
        if (replyText) {
          try {
            await replyTextMessage({
              messageId,
              text: replyText
            })

            return {
              kind: 'text',
              ok: true,
              source: 'feishu_gateway',
              message_id: messageId,
              text: replyText,
              reaction_error: reactionError.message
            }
          } catch (replyError) {
            return {
              kind: 'failed',
              ok: false,
              source: 'feishu_gateway',
              stage: 'immediate_ack',
              message_id: messageId,
              reaction_error: reactionError.message,
              reply_error: replyError.message
            }
          }
        }

        return {
          kind: 'failed',
          ok: false,
          source: 'feishu_gateway',
          stage: 'immediate_ack',
          message_id: messageId,
          reaction_error: reactionError.message
        }
      }
    }

    if (!replyText) {
      return null
    }

    try {
      await replyTextMessage({
        messageId,
        text: replyText
      })

      return {
        kind: 'text',
        ok: true,
        source: 'feishu_gateway',
        message_id: messageId,
        text: replyText
      }
    } catch (replyError) {
      return {
        kind: 'failed',
        ok: false,
        source: 'feishu_gateway',
        stage: 'immediate_ack',
        message_id: messageId,
        reply_error: replyError.message
      }
    }
  }

  async function start({
    onMessage,
    immediateReactionEmojiType = null,
    immediateReplyText = null
  }) {
    const eventDispatcher = new sdk.EventDispatcher({
      encryptKey: config.encryptKey ?? undefined,
      verificationToken: config.verificationToken ?? undefined
    }).register({
      'im.message.receive_v1': (payload) => {
        const normalized = normalizeIncomingEvent(payload)
        lastEventAt = new Date().toISOString()

        if (markMessageSeen(normalized.message_id)) {
          return
        }

        if (
          typeof onMessage === 'function' ||
          immediateReactionEmojiType ||
          immediateReplyText
        ) {
          Promise.resolve()
            .then(async () => {
              const immediateAck = await performImmediateAck({
                messageId: normalized.message_id,
                reactionEmojiType: immediateReactionEmojiType,
                replyText: immediateReplyText
              })

              if (typeof onMessage === 'function') {
                await onMessage({
                  ...normalized,
                  immediate_ack: immediateAck
                })
              }
            })
            .catch((error) => {
              console.error('[newagent][feishu] async onMessage failed', {
                message_id: normalized.message_id,
                event_type: normalized.event_type,
                error: error?.message ?? String(error)
              })
            })
        }
      }
    })

    await wsClient.start({
      eventDispatcher
    })
    started = true

    return getState()
  }

  function close({
    force = false
  } = {}) {
    wsClient.close({
      force
    })
    started = false
  }

  function getState() {
    return {
      channel: 'feishu',
      connection_mode: 'long_connection',
      started,
      last_event_at: lastEventAt
    }
  }

  return {
    getState,
    normalizeIncomingEvent,
    sendMessage,
    sendTextMessage,
    sendInteractiveCard,
    replyMessage,
    replyTextMessage,
    replyInteractiveCard,
    updateMessage,
    updateTextMessage,
    addMessageReaction,
    deleteMessageReaction,
    listMessageReactions,
    start,
    close
  }
}
