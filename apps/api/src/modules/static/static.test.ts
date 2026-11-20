// modules/static/static.test.ts — dashboard served from the API process.
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeTestApp } from '../../test/helpers.js';

async function fixtureDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'router-public-'));
  await mkdir(path.join(dir, 'assets'), { recursive: true });
  await writeFile(
    path.join(dir, 'index.html'),
    '<!doctype html><title>Jhinuk AI Router — Dashboard</title><div id="root"></div>',
  );
  await writeFile(path.join(dir, 'assets', 'app.js'), 'console.log("hi");');
  return dir;
}

describe('static dashboard', () => {
  it('serves the dashboard at / and assets under /assets', async () => {
    const dir = await fixtureDir();
    try {
      const { app } = await makeTestApp({ PUBLIC_DIR: dir });
      const home = await app.inject({ method: 'GET', url: '/' });
      expect(home.statusCode).toBe(200);
      expect(home.headers['content-type']).toContain('text/html');
      expect(home.body).toContain('Jhinuk AI Router');

      const asset = await app.inject({ method: 'GET', url: '/assets/app.js' });
      expect(asset.statusCode).toBe(200);
      expect(asset.headers['content-type']).toContain('javascript');
      expect(asset.body).toContain('console.log');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('falls back to index.html for SPA routes but keeps API paths JSON', async () => {
    const dir = await fixtureDir();
    try {
      const { app } = await makeTestApp({ PUBLIC_DIR: dir });
      const spa = await app.inject({ method: 'GET', url: '/overview' });
      expect(spa.statusCode).toBe(200);
      expect(spa.headers['content-type']).toContain('text/html');

      const unknownApi = await app.inject({ method: 'GET', url: '/v1/nope' });
      expect(unknownApi.statusCode).toBe(404);
      expect(unknownApi.headers['content-type']).toContain('application/json');

      const unknownDashboardApi = await app.inject({ method: 'GET', url: '/api/nope' });
      expect(unknownDashboardApi.statusCode).toBe(404);
      expect(unknownDashboardApi.headers['content-type']).toContain('application/json');

      const health = await app.inject({ method: 'GET', url: '/health' });
      expect(health.statusCode).toBe(200);
      expect(health.json()).toMatchObject({ status: 'ok' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns JSON 404 for / when the dashboard files are missing', async () => {
    const { app } = await makeTestApp({ PUBLIC_DIR: '/definitely/not/a/real/dir' });
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/json');
  });
});
