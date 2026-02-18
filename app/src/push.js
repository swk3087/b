import webpush from 'web-push';
import { hasWebPushConfig, webPushConfig } from './config.js';

const cfg = webPushConfig();
let pushReady = false;

if (hasWebPushConfig()) {
  webpush.setVapidDetails(cfg.subject, cfg.publicKey, cfg.privateKey);
  pushReady = true;
}

function isInvalidSubscriptionError(error) {
  const code = Number(error?.statusCode || 0);
  return code === 404 || code === 410;
}

export function pushEnabled() {
  return pushReady;
}

export function pushPublicKey() {
  return cfg.publicKey || '';
}

export async function sendPushToSubscriptions(subscriptions, payload) {
  if (!pushReady) {
    return {
      enabled: false,
      sent: 0,
      failed: 0,
      invalidEndpoints: []
    };
  }

  const list = (subscriptions || []).filter((sub) => sub?.endpoint);
  const invalidEndpoints = [];
  let sent = 0;
  let failed = 0;

  await Promise.all(
    list.map(async (subscription) => {
      try {
        await webpush.sendNotification(
          subscription,
          JSON.stringify({
            title: payload?.title || 'PlanRiseAI',
            body: payload?.body || '오늘 할 일을 시작할 시간입니다.',
            url: payload?.url || '/'
          })
        );
        sent += 1;
      } catch (error) {
        failed += 1;
        if (isInvalidSubscriptionError(error)) {
          invalidEndpoints.push(subscription.endpoint);
        }
      }
    })
  );

  return { enabled: true, sent, failed, invalidEndpoints };
}
