import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../prisma';

const getJwtSecret = (): string => {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('FATAL: JWT_SECRET must be configured with at least 32 characters.');
  }
  return secret;
};

export interface AuthRequest extends Request {
  user?: any;
}

interface UserTokenCache {
  tokenVersion: number;
  email: string;
  expiresAt: number;
}
const userTokenCache = new Map<string, UserTokenCache>();
const USER_CACHE_TTL_MS = 5000;
const MAX_CACHE_ENTRIES = 10000;

export const invalidateUserTokenCache = (userId: string) => {
  userTokenCache.delete(userId);
};

export const authenticateJWT = (req: AuthRequest, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ')
    ? authHeader.split(' ')[1]
    : (req.query.token as string) || (authHeader ? authHeader.split(' ')[1] : undefined);

  if (token) {
    try {
      const secret = getJwtSecret();
      jwt.verify(token, secret, { algorithms: ['HS256'] }, async (err: any, decoded: any) => {
        if (err || !decoded?.id) {
          return res.status(403).json({ error: 'Invalid or expired token' });
        }

        try {
          const now = Date.now();
          const cached = userTokenCache.get(decoded.id);

          let dbUser: { id: string; email: string; tokenVersion: number } | null = null;

          if (cached && now < cached.expiresAt) {
            dbUser = { id: decoded.id, email: cached.email, tokenVersion: cached.tokenVersion };
          } else {
            const fetched = await prisma.user.findUnique({
              where: { id: decoded.id },
              select: { id: true, email: true, tokenVersion: true },
            });

            if (fetched) {
              dbUser = fetched;
              if (userTokenCache.size >= MAX_CACHE_ENTRIES) {
                userTokenCache.clear();
              }
              userTokenCache.set(decoded.id, {
                tokenVersion: fetched.tokenVersion,
                email: fetched.email,
                expiresAt: now + USER_CACHE_TTL_MS,
              });
            }
          }

          if (!dbUser) {
            return res.status(401).json({ error: 'User account no longer exists' });
          }

          if (decoded.tokenVersion !== undefined && decoded.tokenVersion !== dbUser.tokenVersion) {
            userTokenCache.delete(decoded.id);
            return res.status(403).json({ error: 'Session revoked. Please log in again.' });
          }

          req.user = {
            id: dbUser.id,
            email: dbUser.email,
            tokenVersion: dbUser.tokenVersion,
          };
          next();
        } catch (dbErr) {
          return res.status(500).json({ error: 'Internal error during authentication check' });
        }
      });
    } catch (configErr) {
      return res.status(500).json({ error: 'Authentication configuration error' });
    }
  } else {
    res.status(401).json({ error: 'Authorization header required' });
  }
};

export const requireRole = (requiredRoles: string[]) => {
  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    const userId = req.user?.id;
    const workspaceId = req.params.workspaceId || req.body.workspaceId;

    if (!userId || !workspaceId) {
      return res.status(400).json({ error: 'Missing userId or workspaceId for role check' });
    }

    try {
      const membership = await prisma.workspaceMember.findUnique({
        where: {
          userId_workspaceId: {
            userId,
            workspaceId
          }
        }
      });

      if (!membership || !requiredRoles.includes(membership.role)) {
        return res.status(403).json({ error: 'Forbidden: You do not have the required role.' });
      }

      next();
    } catch (error) {
      res.status(500).json({ error: 'Internal server error during role validation' });
    }
  };
};
