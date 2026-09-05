import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2'
import type { MagicLinkSender } from './better-auth.js'

export class SesMagicLinkSender implements MagicLinkSender {
  constructor(
    private readonly client: SESv2Client,
    private readonly from: string,
  ) {
    if (!/^\S+@\S+\.\S+$/.test(from) || from.length > 254) throw new Error('MAGIC_LINK_FROM must be a valid mailbox')
  }

  async send(input: { email: string; url: string; expiresInSeconds: number }): Promise<void> {
    const url = new URL(input.url)
    if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
      throw new Error('Refusing to send a non-HTTPS production magic link')
    }
    await this.client.send(new SendEmailCommand({
      FromEmailAddress: this.from,
      Destination: { ToAddresses: [input.email] },
      Content: {
        Simple: {
          Subject: { Data: 'Sign in to LineRecall', Charset: 'UTF-8' },
          Body: {
            Text: {
              Charset: 'UTF-8',
              Data: `Use this one-time link to sign in to LineRecall:\n\n${url.toString()}\n\nIt expires in ${Math.floor(input.expiresInSeconds / 60)} minutes. If you did not request it, ignore this message.`,
            },
          },
        },
      },
    }))
  }
}
