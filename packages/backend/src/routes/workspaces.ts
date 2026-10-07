import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { authenticateJWT, requireRole } from '../middleware/rbac';
import { AuthRequest } from '../middleware/rbac';

const router = Router();
const prisma = new PrismaClient();

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

// Create a new workspace
router.post('/', authenticateJWT, async (req: AuthRequest, res) => {
  const userId = req.user?.id;
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Workspace name required' });

  try {
    const workspace = await prisma.workspace.create({
      data: {
        name,
        members: {
          create: {
            userId,
            role: 'ADMIN',
          }
        }
      }
    });
    res.status(201).json(workspace);
  } catch (error) {
    res.status(500).json({ error: 'Failed to create workspace' });
  }
});

// Invite a member (Requires ADMIN)
router.post('/:workspaceId/invite', authenticateJWT, requireRole(['ADMIN']), async (req: AuthRequest, res) => {
  const { workspaceId } = req.params;
  const { email, role } = req.body; // role can be "ADMIN", "EDITOR", "VIEWER"

  try {
    const userToInvite = await prisma.user.findUnique({ where: { email } });
    if (!userToInvite) return res.status(404).json({ error: 'User not found' });

    const member = await prisma.workspaceMember.upsert({
      where: {
        userId_workspaceId: { userId: userToInvite.id, workspaceId }
      },
      update: { role: role || 'VIEWER' },
      create: {
        userId: userToInvite.id,
        workspaceId,
        role: role || 'VIEWER'
      }
    });
    res.json({ message: 'User invited', member });
  } catch (error) {
    res.status(500).json({ error: 'Failed to invite user' });
  }
});

export default router;
