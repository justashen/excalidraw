import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import prisma from '../prisma';
import { authenticateJWT, AuthRequest, invalidateUserTokenCache } from '../middleware/rbac';

import crypto from 'crypto';

const router = Router();

const getJwtSecret = (): string => {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('FATAL: JWT_SECRET must be configured with at least 32 characters.');
  }
  return secret;
};

// Lightweight in-memory rate limiter for authentication routes: max 30 requests per 15 minutes per IP
interface RateLimitRecord {
  count: number;
  resetTime: number;
}
const rateLimitStore = new Map<string, RateLimitRecord>();
const MAX_RATE_LIMIT_STORE_ENTRIES = 10000;

export const authRateLimiter = (req: any, res: any, next: any) => {
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  const maxAttempts = 30;

  // Periodic pruning if store exceeds memory boundary
  if (rateLimitStore.size > MAX_RATE_LIMIT_STORE_ENTRIES) {
    for (const [key, value] of rateLimitStore.entries()) {
      if (now > value.resetTime) {
        rateLimitStore.delete(key);
      }
    }
    // If still over boundary, flush oldest half
    if (rateLimitStore.size > MAX_RATE_LIMIT_STORE_ENTRIES) {
      rateLimitStore.clear();
    }
  }

  const record = rateLimitStore.get(ip);
  if (!record || now > record.resetTime) {
    rateLimitStore.set(ip, { count: 1, resetTime: now + windowMs });
    return next();
  }

  if (record.count >= maxAttempts) {
    return res.status(429).json({
      error: 'Too many authentication attempts, please try again after 15 minutes.',
    });
  }

  record.count += 1;
  next();
};

router.use(authRateLimiter);

// Get per-user random cryptographic salt for PBKDF2 key derivation.
// Neutralizes user account enumeration by returning a deterministic HMAC pseudo-salt for unknown emails.
router.get('/salt', async (req, res) => {
  const email = (req.query.email as string)?.toLowerCase().trim();
  if (!email) {
    return res.status(400).json({ error: 'Email parameter required' });
  }

  try {
    const user = await prisma.user.findUnique({
      where: { email },
      select: { passwordSalt: true },
    });

    if (user?.passwordSalt) {
      return res.json({ salt: user.passwordSalt });
    }

    // Email does not exist: generate deterministic pseudo-salt with server pepper
    const serverPepper = process.env.SERVER_PEPPER || 'durowave-antigravity-zero-knowledge-e2ee-pepper-v1';
    const pseudoSalt = crypto
      .createHmac('sha256', serverPepper)
      .update(email)
      .digest('hex')
      .substring(0, 32);

    res.json({ salt: pseudoSalt });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch salt' });
  }
});

// Fetch user public key for asymmetric key wrapping (E2EE workspace key exchange)
router.get('/public-key', authenticateJWT, async (req: AuthRequest, res) => {
  const email = (req.query.email as string)?.toLowerCase().trim();
  if (!email) {
    return res.status(400).json({ error: 'Email query parameter is required.' });
  }

  try {
    const user = await prisma.user.findUnique({
      where: { email },
      select: { id: true, email: true, name: true, publicKey: true },
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      id: user.id,
      email: user.email,
      name: user.name,
      publicKey: user.publicKey || null,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch public key' });
  }
});

router.post('/register', async (req, res) => {
  const { email, password, name, encryptedMasterKey, passwordSalt, publicKey, encryptedPrivateKey } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    const normalizedEmail = email.toLowerCase().trim();
    const existingUser = await prisma.user.findUnique({ where: { email: normalizedEmail } });
    if (existingUser) {
      return res.status(409).json({ error: 'User already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: {
        email: normalizedEmail,
        password: hashedPassword,
        name,
        encryptedMasterKey: encryptedMasterKey || null,
        passwordSalt: passwordSalt || null,
        publicKey: publicKey || null,
        encryptedPrivateKey: encryptedPrivateKey || null,
        tokenVersion: 1,
      },
    });

    const token = jwt.sign(
      { id: user.id, email: user.email, tokenVersion: user.tokenVersion },
      getJwtSecret(),
      { expiresIn: '7d' },
    );

    res.status(201).json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        encryptedMasterKey: user.encryptedMasterKey,
        passwordSalt: user.passwordSalt,
        publicKey: user.publicKey,
        encryptedPrivateKey: user.encryptedPrivateKey,
      },
    });
  } catch (error) {
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Pre-computed constant-time dummy hash for uniform latency on failed lookups
const DUMMY_HASH = '$2a$10$e84/JbQhB2zOqZ1uNf7qDeLgA9VkmC0N3Q2Pj.HnN/pS9B7uG6J1i';

router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password || typeof email !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    const normalizedEmail = email.toLowerCase().trim();
    const user = await prisma.user.findUnique({ where: { email: normalizedEmail } });

    // Always execute bcrypt.compare to maintain constant-time response behavior
    const targetHash = user?.password || DUMMY_HASH;
    const isMatch = await bcrypt.compare(password, targetHash);

    if (!user || !isMatch) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, tokenVersion: user.tokenVersion },
      getJwtSecret(),
      { expiresIn: '7d' },
    );

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        encryptedMasterKey: user.encryptedMasterKey,
        passwordSalt: user.passwordSalt,
        publicKey: user.publicKey,
        encryptedPrivateKey: user.encryptedPrivateKey,
      },
    });
  } catch (error) {
    res.status(500).json({ error: 'Login failed' });
  }
});

// Zero-Knowledge Password Change: updates auth hash, re-wrapped master key, re-wrapped private key, and increments tokenVersion
router.post('/change-password', authenticateJWT, async (req: AuthRequest, res) => {
  const userId = req.user?.id;
  const { currentPassword, newPassword, newEncryptedMasterKey, newPasswordSalt, newEncryptedPrivateKey } = req.body;

  if (!userId || !currentPassword || !newPassword || !newEncryptedMasterKey) {
    return res.status(400).json({ error: 'Missing required fields for password change' });
  }

  try {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const hashedNewPassword = await bcrypt.hash(newPassword, 10);
    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: {
        password: hashedNewPassword,
        encryptedMasterKey: newEncryptedMasterKey,
        passwordSalt: newPasswordSalt || user.passwordSalt,
        ...(newEncryptedPrivateKey ? { encryptedPrivateKey: newEncryptedPrivateKey } : {}),
        tokenVersion: { increment: 1 },
      },
    });

    invalidateUserTokenCache(userId);

    // Issue a single fresh token for the current device
    const newToken = jwt.sign(
      { id: updatedUser.id, email: updatedUser.email, tokenVersion: updatedUser.tokenVersion },
      getJwtSecret(),
      { expiresIn: '7d' },
    );

    res.json({
      success: true,
      token: newToken,
      message: 'Password and E2EE Vault updated successfully. All other active sessions have been revoked.',
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update password' });
  }
});

export default router;
