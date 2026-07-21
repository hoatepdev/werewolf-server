import { Injectable, Logger } from '@nestjs/common';

interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, string | undefined>;
}

interface PushResult {
  sent: number;
  invalidTokens: string[];
}

@Injectable()
export class PushNotificationService {
  private readonly logger = new Logger(PushNotificationService.name);
  private messagingPromise: Promise<any | null> | null = null;

  private async getMessaging(): Promise<any | null> {
    if (this.messagingPromise) return this.messagingPromise;

    this.messagingPromise = (async () => {
      const hasExplicitCredentials =
        process.env.FIREBASE_PROJECT_ID &&
        process.env.FIREBASE_CLIENT_EMAIL &&
        process.env.FIREBASE_PRIVATE_KEY;
      const hasCredentialFile = process.env.GOOGLE_APPLICATION_CREDENTIALS;

      if (!hasExplicitCredentials && !hasCredentialFile) {
        this.logger.debug('Firebase Admin is not configured; push is disabled.');
        return null;
      }

      try {
        const { applicationDefault, cert, getApps, initializeApp } =
          await import('firebase-admin/app');
        const { getMessaging } = await import('firebase-admin/messaging');

        if (getApps().length === 0) {
          if (hasExplicitCredentials) {
            initializeApp({
              credential: cert({
                projectId: process.env.FIREBASE_PROJECT_ID,
                clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
              }),
            });
          } else {
            initializeApp({
              credential: applicationDefault(),
            });
          }
        }
        return getMessaging();
      } catch (error) {
        this.logger.warn(`Firebase Admin init failed: ${String(error)}`);
        return null;
      }
    })();

    return this.messagingPromise;
  }

  async sendToTokens(tokens: string[], payload: PushPayload): Promise<PushResult> {
    const uniqueTokens = Array.from(new Set(tokens)).filter(Boolean);
    if (uniqueTokens.length === 0) return { sent: 0, invalidTokens: [] };

    const messaging = await this.getMessaging();
    if (!messaging) return { sent: 0, invalidTokens: [] };

    const data = Object.fromEntries(
      Object.entries(payload.data ?? {}).filter(([, value]) => value !== undefined),
    ) as Record<string, string>;

    try {
      const response = await messaging.sendEachForMulticast({
        tokens: uniqueTokens,
        notification: {
          title: payload.title,
          body: payload.body,
        },
        data,
        webpush: {
          fcmOptions: data.url ? { link: data.url } : undefined,
        },
      });

      const invalidTokens = response.responses
        .map((result: { success: boolean; error?: { code?: string } }, index: number) => {
          if (result.success) return null;
          const code = result.error?.code;
          return code === 'messaging/invalid-registration-token' ||
            code === 'messaging/registration-token-not-registered'
            ? uniqueTokens[index]
            : null;
        })
        .filter((token: string | null): token is string => Boolean(token));

      return { sent: response.successCount, invalidTokens };
    } catch (error) {
      this.logger.warn(`Push send failed: ${String(error)}`);
      return { sent: 0, invalidTokens: [] };
    }
  }
}
