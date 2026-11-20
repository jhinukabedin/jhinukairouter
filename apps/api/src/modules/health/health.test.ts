import { describe, expect, it } from 'vitest';
import { makeTestApp } from '../../test/helpers.js';

describe('health module', () => {
  it('GET /health answers without a database', async () => {
    const { app, db } = await makeTestApp();
    db.dbUp = false;
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { status: string }).status).toBe('ok');
    await app.close();
  });

  it('GET /health/ready is 200 when DB is up, 503 when DB is down', async () => {
    const { app, db } = await makeTestApp();
    const ok = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as { status: string }).status).toBe('ready');
    db.dbUp = false;
    const down = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(down.statusCode).toBe(503);
    expect((down.json() as { status: string }).status).toBe('degraded');
    await app.close();
  });
});
