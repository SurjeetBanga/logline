import assert from 'node:assert/strict';
import { test } from 'node:test';
import { serviceOf, soleService, withService } from './connection-bar';

test('serviceOf reads the service a query names, a quoted name or a group as one value', () => {
  assert.equal(serviceOf('level:error'), '');
  assert.equal(serviceOf('level:error service:checkout'), 'checkout');
  assert.equal(serviceOf('service:"payments api" level:error'), 'payments api');
  assert.equal(serviceOf('service:(checkout OR payments) level:error'), '(checkout OR payments)');
});

test('withService replaces every service term, a group included, or removes them', () => {
  assert.equal(withService('level:error service:checkout', 'billing'), 'level:error service:billing');
  assert.equal(withService('level:error', 'payments api'), 'level:error service:"payments api"');
  assert.equal(
    withService('service:(checkout OR payments) @http.status_code:500', 'billing'),
    '@http.status_code:500 service:billing',
  );
  assert.equal(withService('service:(a OR (b OR c)) x', ''), 'x');
  assert.equal(withService('level:error service:checkout', ''), 'level:error');
});

test('soleService is the one name a query searches, and undefined when it may search more', () => {
  assert.equal(soleService('level:error service:checkout'), 'checkout');
  assert.equal(soleService('service:"payments api"'), 'payments api', 'a quoted name is a name, spaces and all');
  assert.equal(soleService('service:"check*"'), 'check*', 'quoted, `*` is part of the name');
  assert.equal(soleService('level:error'), undefined);
  assert.equal(soleService('service:check*'), undefined);
  assert.equal(soleService('service:(checkout OR payments)'), undefined);
  assert.equal(soleService('service:checkout OR service:payments'), undefined);
  assert.equal(soleService('level:error OR service:checkout'), undefined);
  assert.equal(soleService('NOT service:checkout'), undefined);
  assert.equal(soleService('-service:checkout'), undefined);
  assert.equal(soleService('service:checkout -service:payments'), undefined);
  assert.equal(soleService('(service:checkout level:error)'), undefined);
});
