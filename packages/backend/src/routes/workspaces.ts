import { Router } from 'express';
import prisma from '../prisma';
import { authenticateJWT, requireRole } from '../middleware/rbac';
import { AuthRequest } from '../middleware/rbac';

const router = Router();

// Strict role allowlist
const VALID_ROLES = new Set(['ADMIN', 'EDITOR', 'VIEWER']);

// Get all workspaces for the authenticated user
router.get('/', authenticateJWT, async (req: AuthRequest, res) => {
  const userId = req.user?.id;
  try {
    const memberships = await prisma.workspaceMember.findMany({
      where: { userId },
      include: { workspace: true },
    });
    const workspaces = memberships.map(m => ({ ...m.workspace, role: m.role }));
    res.json(workspaces);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch workspaces' });
  }
});

// Create a new workspace with optional initial encrypted DEK
router.post('/', authenticateJWT, async (req: AuthRequest, res) => {
  const userId = req.user?.id;
  const { name, encryptedDek } = req.body;
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return res.status(400).json({ error: 'Valid workspace name is required' });
  }

  try {
    const workspace = await prisma.workspace.create({
      data: {
        name: name.trim(),
        members: {
          create: {
            userId,
            role: 'ADMIN',
          },
        },
        ...(encryptedDek
          ? {
              workspaceKeys: {
                create: {
                  userId,
                  encryptedDek,
                },
              },
            }
          : {}),
      },
      include: {
        workspaceKeys: true,
      },
    });
    res.status(201).json(workspace);
  } catch (error) {
    res.status(500).json({ error: 'Failed to create workspace' });
  }
});

// Get the caller's encrypted Workspace DEK for zero-knowledge decryption
router.get('/:workspaceId/key', authenticateJWT, async (req: AuthRequest, res) => {
  const { workspaceId } = req.params;
  const userId = req.user?.id;

  try {
    // Verify user is a member of this workspace
    const membership = await prisma.workspaceMember.findUnique({
      where: {
        userId_workspaceId: { userId, workspaceId },
      },
    });

    if (!membership) {
      return res.status(403).json({ error: 'Forbidden: You are not a member of this workspace.' });
    }

    const keyRecord = await prisma.workspaceKey.findUnique({
      where: {
        workspaceId_userId: { workspaceId, userId },
      },
    });

    res.json({
      workspaceId,
      encryptedDek: keyRecord?.encryptedDek || null,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch workspace encryption key.' });
  }
});

// Store or update caller's wrapped Workspace DEK
router.post('/:workspaceId/key', authenticateJWT, async (req: AuthRequest, res) => {
  const { workspaceId } = req.params;
  const userId = req.user?.id;
  const { encryptedDek } = req.body;

  if (!encryptedDek || typeof encryptedDek !== 'string') {
    return res.status(400).json({ error: 'encryptedDek string is required.' });
  }

  try {
    const membership = await prisma.workspaceMember.findUnique({
      where: {
        userId_workspaceId: { userId, workspaceId },
      },
    });

    if (!membership) {
      return res.status(403).json({ error: 'Forbidden: You are not a member of this workspace.' });
    }

    const keyRecord = await prisma.workspaceKey.upsert({
      where: {
        workspaceId_userId: { workspaceId, userId },
      },
      update: { encryptedDek },
      create: {
        workspaceId,
        userId,
        encryptedDek,
      },
    });

    res.json({ success: true, keyRecord });
  } catch (err) {
    res.status(500).json({ error: 'Failed to store workspace encryption key.' });
  }
});

// Invite a member (Requires ADMIN)
router.post('/:workspaceId/invite', authenticateJWT, requireRole(['ADMIN']), async (req: AuthRequest, res) => {
  const { workspaceId } = req.params;
  const { email, role, encryptedDek } = req.body; // role can be "ADMIN", "EDITOR", "VIEWER"

  if (!email || typeof email !== 'string') {
    return res.status(400).json({ error: 'Target user email is required.' });
  }

  const assignedRole = role || 'VIEWER';
  if (!VALID_ROLES.has(assignedRole)) {
    return res.status(400).json({
      error: `Invalid role '${assignedRole}'. Permitted roles are: ${Array.from(VALID_ROLES).join(', ')}`,
    });
  }

  try {
    const userToInvite = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
    if (!userToInvite) return res.status(404).json({ error: 'User not found' });

    const member = await prisma.workspaceMember.upsert({
      where: {
        userId_workspaceId: { userId: userToInvite.id, workspaceId },
      },
      update: { role: assignedRole },
      create: {
        userId: userToInvite.id,
        workspaceId,
        role: assignedRole,
      },
    });

    // If encrypted Workspace DEK was prepared for the invited user, store it
    if (encryptedDek && typeof encryptedDek === 'string') {
      await prisma.workspaceKey.upsert({
        where: {
          workspaceId_userId: {
            workspaceId,
            userId: userToInvite.id,
          },
        },
        update: { encryptedDek },
        create: {
          workspaceId,
          userId: userToInvite.id,
          encryptedDek,
        },
      });
    }

    // If demoting to VIEWER, actively evict live sockets from active document rooms
    if (assignedRole === 'VIEWER') {
      const { evictUserFromWorkspaceRooms } = await import('../index');
      await evictUserFromWorkspaceRooms(userToInvite.id, workspaceId);
    }

    res.json({ message: 'User invited successfully', member });
  } catch (error) {
    res.status(500).json({ error: 'Failed to invite user' });
  }
});

// Remove a member from a workspace (Requires ADMIN)
router.delete('/:workspaceId/members/:targetUserId', authenticateJWT, requireRole(['ADMIN']), async (req: AuthRequest, res) => {
  const { workspaceId, targetUserId } = req.params;

  try {
    const targetMember = await prisma.workspaceMember.findUnique({
      where: {
        userId_workspaceId: {
          userId: targetUserId,
          workspaceId,
        },
      },
    });

    if (!targetMember) {
      return res.status(404).json({ error: 'Member not found in workspace' });
    }

    // Guard: Prevent removing the last remaining administrator
    if (targetMember.role === 'ADMIN') {
      const adminCount = await prisma.workspaceMember.count({
        where: {
          workspaceId,
          role: 'ADMIN',
        },
      });

      if (adminCount <= 1) {
        return res.status(400).json({ error: 'Cannot remove the last administrator of the workspace.' });
      }
    }

    await prisma.workspaceMember.delete({
      where: {
        userId_workspaceId: {
          userId: targetUserId,
          workspaceId,
        },
      },
    });

    // Actively evict removed user from all active document socket rooms in this workspace
    const { evictUserFromWorkspaceRooms } = await import('../index');
    await evictUserFromWorkspaceRooms(targetUserId, workspaceId);

    res.json({ success: true, message: 'Member removed and live sessions evicted.' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to remove workspace member' });
  }
});

export default router;
