import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ZodError } from 'zod';

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/**
 * True only for a request made on the computer running PeerBeats. Phone link traffic also
 * arrives from 127.0.0.1, so the address alone proves nothing: the proxy headers and the Host
 * name are what tell a phone apart from this computer.
 */
export function isOnThisComputer(req: Request): boolean {
  const address = req.socket.remoteAddress ?? '';
  const loopback = address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
  const proxied = Boolean(req.headers['x-forwarded-for'] || req.headers['cf-connecting-ip']);
  const host = (req.headers.host ?? '').replace(/:\d+$/, '');
  return loopback && !proxied && ['localhost', '127.0.0.1', '[::1]'].includes(host);
}

/** Lets route handlers be async: a rejected promise goes to the error handler. */
export const wrap =
  (handler: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    handler(req, res)
      .then(() => {
        // A handler that sent nothing is acting as middleware, so pass the request on.
        if (!res.headersSent) next();
      })
      .catch(next);
  };

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    res.status(400).json({ error: err.issues[0]?.message ?? 'Invalid input' });
    return;
  }
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  // Body parser errors: too large, or not valid JSON. These are the sender's mistake, not ours.
  const status = (err as { status?: number }).status;
  if (status === 413) {
    res.status(413).json({ error: 'That file is too large. The limit is 50 MB.' });
    return;
  }
  if (status && status >= 400 && status < 500) {
    res.status(status).json({ error: 'That request wasn\u2019t valid.' });
    return;
  }
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
}
