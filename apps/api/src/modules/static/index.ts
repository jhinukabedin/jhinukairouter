// modules/static/index.ts — serve the dashboard SPA from the API process.
//
// BHPanel cannot proxy only /v1/, /api/ and /health to the container while
// serving the rest from the document root (whole-site attach only), so the
// API itself serves the built dashboard (apps/web/dist, copied into the
// image as ./public) at the same origin. No new dependency: plain fs reads.
//
// Rules:
// - GET / -> public/index.html
// - GET /assets/<file> -> the file (allowlisted extensions only)
// - GET /<anything-else> -> public/index.html (SPA fallback), EXCEPT paths
//   under /v1, /api or /health, which stay JSON 404s (they belong to the API)
// - Path traversal is rejected; a missing public dir means the dashboard is
//   unavailable (404 JSON) but the API keeps working.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function isApiPath(urlPath: string): boolean {
  return (
    urlPath === '/v1' ||
    urlPath.startsWith('/v1/') ||
    urlPath === '/api' ||
    urlPath.startsWith('/api/') ||
    urlPath === '/health' ||
    urlPath.startsWith('/health/')
  );
}

export async function staticRoutes(
  fastify: FastifyInstance,
  opts: { publicDir: string },
): Promise<void> {
  const root = path.resolve(opts.publicDir);

  async function sendFile(
    reply: FastifyReply,
    relPath: string,
  ): Promise<FastifyReply> {
    const resolved = path.resolve(root, relPath);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
    }
    const ext = path.extname(resolved).toLowerCase();
    if (!MIME[ext]) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
    }
    try {
      const data = await readFile(resolved);
      return reply.header('Content-Type', MIME[ext]).send(data);
    } catch {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
    }
  }

  // Dashboard entry point.
  fastify.get('/', async (_request: FastifyRequest, reply: FastifyReply) => {
    return sendFile(reply, 'index.html');
  });

  // Static assets + SPA fallback. Registered API routes (static paths like
  // /health, /v1/models) win over this wildcard in Fastify's router; the
  // isApiPath guard keeps unknown /v1, /api and /health paths as JSON 404s
  // instead of serving the dashboard for them.
  fastify.get('/*', async (request: FastifyRequest, reply: FastifyReply) => {
    const urlPath = new URL(request.url, 'http://x').pathname;
    if (isApiPath(urlPath)) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
    }
    if (urlPath.startsWith('/assets/')) {
      return sendFile(reply, urlPath.slice(1));
    }
    return sendFile(reply, 'index.html');
  });
}
