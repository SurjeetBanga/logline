import assert from 'node:assert/strict';
import test from 'node:test';
import { ViewNotifications } from './vscode/view-notifications';

test('view notifications coalesce bursts, support direct sends, and dispose idempotently', async () => {
  const messages: unknown[] = [];
  const notifications = new ViewNotifications({ get: (_key, fallback) => 5 as typeof fallback });
  const subscription = notifications.subscribe(message => messages.push(message));
  notifications.notify(); notifications.notify(); notifications.notify();
  notifications.send({ type: 'serversChanged' });
  assert.deepEqual(messages, [{ type: 'update' }, { type: 'serversChanged' }]);
  await new Promise(resolve => setTimeout(resolve, 30));
  notifications.notify();
  assert.equal(messages.filter(message => (message as any).type === 'update').length, 3);
  subscription.dispose();
  notifications.dispose(); notifications.dispose(); notifications.notify(); notifications.send({ type: 'serversChanged' });
  assert.equal(messages.length, 4);
});
