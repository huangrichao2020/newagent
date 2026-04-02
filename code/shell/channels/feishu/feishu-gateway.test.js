import test from 'node:test'
import assert from 'node:assert/strict'
import { createFeishuGateway } from './feishu-gateway.js'

function createFakeSdk({
  reactionError = null,
  replyError = null
} = {}) {
  const calls = {
    create: [],
    reply: [],
    update: [],
    reactionCreate: [],
    started: null,
    close: []
  }

  class FakeClient {
    constructor(_config) {
      this.im = {
        v1: {
          message: {
            create: async (payload) => {
              calls.create.push(payload)
              return {
                ok: true,
                payload
              }
            },
            reply: async (payload) => {
              calls.reply.push(payload)
              if (replyError) {
                throw replyError
              }
              return {
                ok: true,
                payload
              }
            },
            update: async (payload) => {
              calls.update.push(payload)
              return {
                ok: true,
                payload
              }
            }
          },
          messageReaction: {
            create: async (payload) => {
              calls.reactionCreate.push(payload)
              if (reactionError) {
                throw reactionError
              }
              return {
                ok: true,
                payload
              }
            }
          }
        }
      }
    }
  }

  class FakeEventDispatcher {
    constructor(params = {}) {
      this.handlers = {}
      this.verification = params
    }

    register(handlers) {
      this.handlers = handlers
      return this
    }
  }

  class FakeWSClient {
    constructor(_config) {}

    async start(payload) {
      calls.started = payload
    }

    close(payload) {
      calls.close.push(payload)
    }
  }

  return {
    sdk: {
      Client: FakeClient,
      EventDispatcher: FakeEventDispatcher,
      WSClient: FakeWSClient,
      AppType: {
        SelfBuild: 'self-build'
      },
      Domain: {
        Feishu: 'https://open.feishu.cn'
      },
      LoggerLevel: {
        info: 'info'
      }
    },
    calls
  }
}

test('sendTextMessage creates a Feishu text message through the SDK client', async () => {
  const { sdk, calls } = createFakeSdk()
  const gateway = createFeishuGateway({
    appId: 'app-id',
    appSecret: 'app-secret',
    encryptKey: 'encrypt-key',
    verificationToken: 'verification-token',
    sdk
  })

  await gateway.sendTextMessage({
    receiveIdType: 'chat_id',
    receiveId: 'oc_123',
    text: 'hello feishu'
  })

  assert.equal(calls.create.length, 1)
  assert.equal(calls.create[0].params.receive_id_type, 'chat_id')
  assert.equal(JSON.parse(calls.create[0].data.content).text, 'hello feishu')
})

test('replyTextMessage replies to one incoming Feishu message', async () => {
  const { sdk, calls } = createFakeSdk()
  const gateway = createFeishuGateway({
    appId: 'app-id',
    appSecret: 'app-secret',
    sdk
  })

  await gateway.replyTextMessage({
    messageId: 'om_123',
    text: 'ack'
  })

  assert.equal(calls.reply.length, 1)
  assert.equal(calls.reply[0].path.message_id, 'om_123')
  assert.equal(JSON.parse(calls.reply[0].data.content).text, 'ack')
})

test('updateTextMessage edits one existing Feishu text message', async () => {
  const { sdk, calls } = createFakeSdk()
  const gateway = createFeishuGateway({
    appId: 'app-id',
    appSecret: 'app-secret',
    sdk
  })

  await gateway.updateTextMessage({
    messageId: 'om_update_123',
    text: 'updated reply'
  })

  assert.equal(calls.update.length, 1)
  assert.equal(calls.update[0].path.message_id, 'om_update_123')
  assert.equal(calls.update[0].data.msg_type, 'text')
  assert.equal(JSON.parse(calls.update[0].data.content).text, 'updated reply')
})

test('addMessageReaction adds one reaction to the incoming Feishu message', async () => {
  const { sdk, calls } = createFakeSdk()
  const gateway = createFeishuGateway({
    appId: 'app-id',
    appSecret: 'app-secret',
    sdk
  })

  await gateway.addMessageReaction({
    messageId: 'om_456',
    emojiType: 'SMILE'
  })

  assert.equal(calls.reactionCreate.length, 1)
  assert.equal(calls.reactionCreate[0].path.message_id, 'om_456')
  assert.equal(calls.reactionCreate[0].data.reaction_type.emoji_type, 'SMILE')
})

test('replyInteractiveCard replies with one markdown-capable interactive card', async () => {
  const { sdk, calls } = createFakeSdk()
  const gateway = createFeishuGateway({
    appId: 'app-id',
    appSecret: 'app-secret',
    sdk
  })

  await gateway.replyInteractiveCard({
    messageId: 'om_card_123',
    card: {
      header: {
        title: {
          tag: 'plain_text',
          content: '处理完成'
        }
      },
      elements: [
        {
          tag: 'markdown',
          content: '**摘要**\n- ok'
        }
      ]
    }
  })

  assert.equal(calls.reply.length, 1)
  assert.equal(calls.reply[0].path.message_id, 'om_card_123')
  assert.equal(calls.reply[0].data.msg_type, 'interactive')
  assert.equal(JSON.parse(calls.reply[0].data.content).elements[0].tag, 'markdown')
})

test('start registers the long-connection message handler and normalizes inbound events', async () => {
  const { sdk, calls } = createFakeSdk()
  const gateway = createFeishuGateway({
    appId: 'app-id',
    appSecret: 'app-secret',
    encryptKey: 'encrypt-key',
    verificationToken: 'verification-token',
    sdk
  })

  let received = null
  const state = await gateway.start({
    onMessage(message) {
      received = message
    }
  })

  assert.equal(state.started, true)
  assert.equal(typeof calls.started.eventDispatcher.handlers['im.message.receive_v1'], 'function')
  assert.equal(calls.started.eventDispatcher.verification.encryptKey, 'encrypt-key')
  assert.equal(calls.started.eventDispatcher.verification.verificationToken, 'verification-token')

  await calls.started.eventDispatcher.handlers['im.message.receive_v1']({
    header: {
      event_id: 'evt_1',
      event_type: 'im.message.receive_v1'
    },
    event: {
      sender: {
        sender_id: {
          open_id: 'ou_123'
        },
        tenant_key: 'tenant_x'
      },
      message: {
        message_id: 'om_1',
        chat_id: 'oc_1',
        chat_type: 'p2p',
        message_type: 'text',
        content: '{"text":"hello manager"}'
      }
    }
  })
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.equal(received.message_id, 'om_1')
  assert.equal(received.sender_open_id, 'ou_123')
  assert.equal(received.text, 'hello manager')
  assert.deepEqual(received.referenced_message_ids, [])
})

test('start normalizes reply metadata from inbound Feishu events', async () => {
  const { sdk, calls } = createFakeSdk()
  const gateway = createFeishuGateway({
    appId: 'app-id',
    appSecret: 'app-secret',
    sdk
  })

  let received = null
  await gateway.start({
    onMessage(message) {
      received = message
    }
  })

  await calls.started.eventDispatcher.handlers['im.message.receive_v1']({
    header: {
      event_id: 'evt_reply_1',
      event_type: 'im.message.receive_v1'
    },
    event: {
      sender: {
        sender_id: {
          open_id: 'ou_reply_123'
        }
      },
      message: {
        message_id: 'om_reply_1',
        parent_id: 'om_parent_1',
        root_id: 'om_root_1',
        chat_id: 'oc_reply_1',
        chat_type: 'p2p',
        message_type: 'text',
        content: '{"text":"继续这个","reply_to_message_id":"om_parent_1"}'
      }
    }
  })
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.equal(received.parent_message_id, 'om_parent_1')
  assert.equal(received.root_message_id, 'om_root_1')
  assert.deepEqual(received.referenced_message_ids, ['om_parent_1', 'om_root_1'])
})

test('start de-duplicates repeated Feishu message deliveries by message_id', async () => {
  const { sdk, calls } = createFakeSdk()
  const gateway = createFeishuGateway({
    appId: 'app-id',
    appSecret: 'app-secret',
    sdk
  })

  const received = []
  await gateway.start({
    async onMessage(message) {
      received.push(message.message_id)
    }
  })

  const handler = calls.started.eventDispatcher.handlers['im.message.receive_v1']
  const payload = {
    header: {
      event_id: 'evt_2',
      event_type: 'im.message.receive_v1'
    },
    event: {
      sender: {
        sender_id: {
          open_id: 'ou_456'
        }
      },
      message: {
        message_id: 'om_dup',
        chat_id: 'oc_dup',
        chat_type: 'p2p',
        message_type: 'text',
        content: '{"text":"ping"}'
      }
    }
  }

  handler(payload)
  handler(payload)
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.deepEqual(received, ['om_dup'])
})

test('start adds an immediate reaction before dispatching the message handler', async () => {
  const { sdk, calls } = createFakeSdk()
  const gateway = createFeishuGateway({
    appId: 'app-id',
    appSecret: 'app-secret',
    sdk
  })

  let received = null
  await gateway.start({
    immediateReactionEmojiType: 'SMILE',
    immediateReplyText: '已读喵，我在看啦。',
    async onMessage(message) {
      received = message
    }
  })

  const handler = calls.started.eventDispatcher.handlers['im.message.receive_v1']
  handler({
    header: {
      event_id: 'evt_3',
      event_type: 'im.message.receive_v1'
    },
    event: {
      sender: {
        sender_id: {
          open_id: 'ou_789'
        }
      },
      message: {
        message_id: 'om_reaction_first',
        chat_id: 'oc_reaction_first',
        chat_type: 'p2p',
        message_type: 'text',
        content: '{"text":"在吗"}'
      }
    }
  })
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.equal(calls.reactionCreate.length, 1)
  assert.equal(calls.reply.length, 0)
  assert.equal(received.message_id, 'om_reaction_first')
  assert.equal(received.immediate_ack.kind, 'reaction')
  assert.equal(received.immediate_ack.emoji_type, 'SMILE')
})

test('start falls back to an immediate text reply when reaction creation fails', async () => {
  const { sdk, calls } = createFakeSdk({
    reactionError: new Error('reaction unavailable')
  })
  const gateway = createFeishuGateway({
    appId: 'app-id',
    appSecret: 'app-secret',
    sdk
  })

  let received = null
  await gateway.start({
    immediateReactionEmojiType: 'SMILE',
    immediateReplyText: '已读喵，我在看啦。',
    async onMessage(message) {
      received = message
    }
  })

  const handler = calls.started.eventDispatcher.handlers['im.message.receive_v1']
  handler({
    header: {
      event_id: 'evt_4',
      event_type: 'im.message.receive_v1'
    },
    event: {
      sender: {
        sender_id: {
          open_id: 'ou_999'
        }
      },
      message: {
        message_id: 'om_fallback_text',
        chat_id: 'oc_fallback_text',
        chat_type: 'p2p',
        message_type: 'text',
        content: '{"text":"ping"}'
      }
    }
  })
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.equal(calls.reactionCreate.length, 1)
  assert.equal(calls.reply.length, 1)
  assert.equal(received.immediate_ack.kind, 'text')
  assert.equal(received.immediate_ack.text, '已读喵，我在看啦。')
  assert.equal(received.immediate_ack.reaction_error, 'reaction unavailable')
})
