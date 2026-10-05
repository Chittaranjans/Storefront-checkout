import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { AppError, Errors } from './errors';
import { Service } from './service';

export function createServer(service: Service) {
  return createHttpServer((req, res) => {
    handle(service, req, res).catch((err) => sendError(res, err));
  });
}

async function handle(service: Service, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const seg = url.pathname.split('/').filter(Boolean);
  const method = req.method ?? 'GET';

  if (method === 'GET' && seg.length === 1 && seg[0] === 'health') {
    return sendJson(res, 200, { status: 'ok', config: service.store.config });
  }

  if (method === 'GET' && seg.length === 1 && seg[0] === 'products') {
    return sendJson(res, 200, { products: service.listProducts() });
  }

  if (method === 'POST' && seg.length === 1 && seg[0] === 'carts') {
    return sendJson(res, 201, service.createCart());
  }

  if (method === 'GET' && seg.length === 2 && seg[0] === 'carts') {
    return sendJson(res, 200, service.getCart(seg[1]!));
  }

  if (method === 'POST' && seg.length === 3 && seg[0] === 'carts' && seg[2] === 'items') {
    const body = await readJson(req);
    const productId = requireString(body, 'productId');
    const quantity = requireNumber(body, 'quantity');
    return sendJson(res, 200, service.addItem(seg[1]!, productId, quantity));
  }

  if (method === 'PATCH' && seg.length === 4 && seg[0] === 'carts' && seg[2] === 'items') {
    const body = await readJson(req);
    const quantity = requireNumber(body, 'quantity');
    return sendJson(res, 200, service.updateItem(seg[1]!, seg[3]!, quantity));
  }

  if (method === 'DELETE' && seg.length === 4 && seg[0] === 'carts' && seg[2] === 'items') {
    return sendJson(res, 200, service.removeItem(seg[1]!, seg[3]!));
  }

  if (method === 'POST' && seg.length === 3 && seg[0] === 'carts' && seg[2] === 'checkout') {
    const body = await readJson(req);
    const couponCode = optionalString(body, 'couponCode');
    const idempotencyKey = req.headers['idempotency-key'];
    const order = await service.checkout(
      seg[1]!,
      couponCode,
      idempotencyKey ? String(idempotencyKey) : undefined,
    );
    return sendJson(res, 201, order);
  }

  if (method === 'GET' && seg.length === 2 && seg[0] === 'orders') {
    return sendJson(res, 200, service.getOrder(seg[1]!));
  }

  if (method === 'POST' && seg.length === 2 && seg[0] === 'admin' && seg[1] === 'coupons') {
    const coupon = await service.generateCoupon();
    return sendJson(res, 201, coupon);
  }

  if (method === 'GET' && seg.length === 2 && seg[0] === 'admin' && seg[1] === 'report') {
    return sendJson(res, 200, service.report());
  }

  return sendError(res, new AppError(404, 'NOT_FOUND', `No route for ${method} ${url.pathname}`));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw Errors.invalidJson();
  }
}

function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string') throw Errors.invalidRequest(`${field} must be a string`);
  return value;
}

function requireNumber(body: Record<string, unknown>, field: string): number {
  const value = body[field];
  if (typeof value !== 'number') throw Errors.invalidRequest(`${field} must be a number`);
  return value;
}

function optionalString(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw Errors.invalidRequest(`${field} must be a string`);
  return value;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function sendError(res: ServerResponse, err: unknown): void {
  if (err instanceof AppError) {
    return sendJson(res, err.status, err.toJSON());
  }
  console.error(err);
  return sendJson(res, 500, { error: { code: 'INTERNAL_ERROR', message: 'Unexpected server error' } });
}
