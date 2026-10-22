import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import dotenv from 'dotenv';
import path from 'path';
import http from 'http';
import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import prisma from './prisma';

// Load environment variables
dotenv.config({ path: path.join(__dirname, '../../../.env.development') });

// 1. Strict Startup Check: Fail-fast if JWT_SECRET is missing or insecure
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.trim().length < 32) {
  console.error('\x1b[31m%s\x1b[0m', '=======================================================');
  console.error('\x1b[31m%s\x1b[0m', 'FATAL SECURITY ERROR: JWT_SECRET environment variable');
  console.error('\x1b[31m%s\x1b[0m', 'is missing or shorter than 32 characters.');
  console.error('\x1b[31m%s\x1b[0m', 'Backend will not start with insecure authentication.');
  console.error('\x1b[31m%s\x1b[0m', '=======================================================');
  process.exit(1);
}

const app = express();
// Enable helmet security headers (CSP, HSTS, X-Content-Type-Options, X-Frame-Options)
app.use(helmet());
// HTTP Transport Compression for large canvas document JSON payloads (> 1KB)
app.use(compression({
  threshold: 1024,
  filter: (req, res) => {
    if (req.headers['x-no-compression']) return false;
    return compression.filter(req, res);
  },
}));
// Enable trust proxy for accurate client IP resolution behind reverse proxies (Cloudflare, Nginx)
app.set('trust proxy', 1);

const PORT = process.env.PORT || 3002;

// Explicit CORS configuration
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:3002',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3001',
  'http://127.0.0.1:3002',
];

app.use(cors({
  origin: (origin, callback) => {
    // Allow non-browser requests or allowed origins
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Cross-Origin Request Blocked by Security Policy'));
    }
  },
  credentials: true,
}));

// Request size limit guard: prevent Denial-of-Service via payload bloat
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Backend is running with active security protections!' });
});

import authRoutes from './routes/auth';
import workspaceRoutes from './routes/workspaces';
import documentRoutes from './routes/documents';
import filesRoutes from './routes/files';

app.use('/api/auth', authRoutes);
app.use('/api/workspaces', workspaceRoutes);
app.use('/api/documents', documentRoutes);
app.use('/api/files', filesRoutes);

// Create HTTP and Socket.IO server
const server = http.createServer(app);
export const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

// Helper to actively evict revoked or demoted members from live socket rooms
export const evictUserFromWorkspaceRooms = async (userId: string, workspaceId: string) => {
  try {
    const documents = await prisma.document.findMany({
      where: { workspaceId },
      select: { id: true },
    });

    const docIds = new Set(documents.map((d) => d.id));

    // Invalidate cached permissions immediately for this user and evicted rooms
    for (const roomId of docIds) {
      socketAuthCache.delete(`${userId}:${roomId}`);
    }

    const sockets = await io.fetchSockets();

    for (const s of sockets) {
      if (s.data.user?.id === userId) {
        for (const roomId of docIds) {
          if (s.rooms.has(roomId)) {
            s.leave(roomId);
            if (s.data.roomRoles) {
              delete s.data.roomRoles[roomId];
            }
            s.emit('force-leave-room', { roomId, reason: 'Workspace access revoked or demoted.' });
          }
        }
      }
    }
  } catch (err) {
    console.error('Error during live socket room eviction:', err);
  }
};

// In-memory rate limiting and TTL membership cache for real-time socket events
interface AuthCacheEntry {
  role: string;
  expiresAt: number;
}
const socketAuthCache = new Map<string, AuthCacheEntry>();
const socketMessageRate = new Map<string, { count: number; resetAt: number }>();

const MAX_CACHE_ENTRIES = 10000;
const MAX_SOCKET_EVENTS_PER_SEC = 60;
const AUTH_CACHE_TTL_MS = 5000; // 5 seconds cache to protect Prisma connection pool from starvation

const checkSocketRateLimit = (socketId: string, maxEventsPerSec: number = MAX_SOCKET_EVENTS_PER_SEC): boolean => {
  const now = Date.now();
  let rate = socketMessageRate.get(socketId);
  if (!rate || now > rate.resetAt) {
    socketMessageRate.set(socketId, { count: 1, resetAt: now + 1000 });
    return true;
  }
  rate.count += 1;
  return rate.count <= maxEventsPerSec;
};

// Socket.IO authentication middleware: enforce valid JWT token and active session during handshake
io.use(async (socket: Socket, next) => {
  const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.split(' ')[1];

  if (!token) {
    return next(new Error('Authentication required for real-time collaboration.'));
  }

  jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }, async (err: any, decoded: any) => {
    if (err || !decoded?.id) {
      return next(new Error('Invalid or expired authentication token.'));
    }

    try {
      const dbUser = await prisma.user.findUnique({
        where: { id: decoded.id },
        select: { id: true, email: true, tokenVersion: true },
      });

      if (!dbUser) {
        return next(new Error('User account not found.'));
      }

      if (decoded.tokenVersion !== undefined && decoded.tokenVersion !== dbUser.tokenVersion) {
        return next(new Error('Session revoked. Please reconnect with fresh credentials.'));
      }

      socket.data.user = {
        id: dbUser.id,
        email: dbUser.email,
        tokenVersion: dbUser.tokenVersion,
      };
      next();
    } catch (dbErr) {
      next(new Error('Authentication lookup failed'));
    }
  });
});

io.on('connection', (socket: Socket) => {
  const userId = socket.data.user?.id;
  const userEmail = socket.data.user?.email;
  console.log(`Authenticated client connected: ${socket.id} (User: ${userEmail || userId})`);

  // Authorize room joining based on document workspace membership with rate limiting
  socket.on('join-room', async (roomId: string) => {
    if (!checkSocketRateLimit(socket.id, 20)) {
      return socket.emit('error', 'Rate limit exceeded for room join operations.');
    }

    if (!roomId || typeof roomId !== 'string' || roomId.length > 128) {
      return socket.emit('error', 'Invalid room identifier');
    }

    try {
      const document = await prisma.document.findUnique({
        where: { id: roomId },
        select: { workspaceId: true },
      });

      if (!document) {
        return socket.emit('error', 'Document not found');
      }

      const membership = await prisma.workspaceMember.findUnique({
        where: {
          userId_workspaceId: {
            userId,
            workspaceId: document.workspaceId,
          },
        },
      });

      if (!membership) {
        return socket.emit('error', 'Forbidden: You are not a member of this workspace');
      }

      // Store member role in socket session for this room
      socket.data.roomRoles = socket.data.roomRoles || {};
      socket.data.roomRoles[roomId] = membership.role;

      socket.join(roomId);
      console.log(`Socket ${socket.id} joined room ${roomId} with role ${membership.role}`);
    } catch (err) {
      console.error('Error during room authorization:', err);
      socket.emit('error', 'Internal error joining room');
    }
  });

  // Real-time broadcast: rate-limited, room-verified, and TTL-cached to protect backend thread pool
  socket.on('client-broadcast', async (roomId: string, data: any) => {
    if (!roomId || typeof roomId !== 'string') return;
    if (!userId) {
      return socket.emit('error', 'Unauthorized: User session missing.');
    }

    // 1. Mandatory membership validation: emitting socket MUST currently belong to the room
    if (!socket.rooms.has(roomId)) {
      return socket.emit('error', 'Forbidden: You must join the room before broadcasting.');
    }

    // 2. Throttling guard
    if (!checkSocketRateLimit(socket.id, MAX_SOCKET_EVENTS_PER_SEC)) {
      return socket.emit('error', 'Rate limit exceeded: throttling broadcast.');
    }

    const now = Date.now();
    const cacheKey = `${userId}:${roomId}`;
    const cached = socketAuthCache.get(cacheKey);

    let userRole: string | null = null;
    if (cached && now < cached.expiresAt) {
      userRole = cached.role;
    } else {
      try {
        const document = await prisma.document.findUnique({
          where: { id: roomId },
          select: { workspaceId: true },
        });

        if (!document) {
          socketAuthCache.delete(cacheKey);
          socket.leave(roomId);
          return socket.emit('error', 'Document not found.');
        }

        const membership = await prisma.workspaceMember.findUnique({
          where: {
            userId_workspaceId: {
              userId,
              workspaceId: document.workspaceId,
            },
          },
          select: { role: true },
        });

        userRole = membership?.role || null;
        if (userRole) {
          if (socketAuthCache.size >= MAX_CACHE_ENTRIES) {
            socketAuthCache.clear(); // Bounded cache safeguard to prevent DoS memory exhaustion
          }
          socketAuthCache.set(cacheKey, { role: userRole, expiresAt: now + AUTH_CACHE_TTL_MS });
        } else {
          socketAuthCache.delete(cacheKey);
        }
      } catch (broadcastErr) {
        return socket.emit('error', 'Internal error validating broadcast authorization.');
      }
    }

    if (!userRole || userRole === 'VIEWER') {
      socket.data.roomRoles = socket.data.roomRoles || {};
      delete socket.data.roomRoles[roomId];
      socket.leave(roomId);
      socketAuthCache.delete(cacheKey);
      return socket.emit('error', 'Forbidden: Viewers and non-members cannot broadcast canvas changes.');
    }

    // Broadcast only to other clients in the authorized room
    socket.to(roomId).emit('server-broadcast', roomId, data);
  });

  socket.on('disconnect', () => {
    socketMessageRate.delete(socket.id);
    console.log('Client disconnected:', socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`Server is running securely on http://localhost:${PORT}`);
});
