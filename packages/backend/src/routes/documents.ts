import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { authenticateJWT, requireRole } from '../middleware/rbac';
import { AuthRequest } from '../middleware/rbac';

const router = Router();
const prisma = new PrismaClient();

// Get all documents for a workspace (Requires at least VIEWER)
router.get('/workspace/:workspaceId', authenticateJWT, requireRole(['ADMIN', 'EDITOR', 'VIEWER']), async (req: AuthRequest, res) => {
  const { workspaceId } = req.params;
  try {
    const documents = await prisma.document.findMany({
      where: { workspaceId },
      select: { id: true, title: true, createdAt: true, updatedAt: true } // Don't fetch full JSON payload for list
    });
    res.json(documents);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch documents' });
  }
});

// Load a specific document
router.get('/:documentId', authenticateJWT, async (req: AuthRequest, res) => {
  const { documentId } = req.params;
  const userId = req.user?.id;
  try {
    const document = await prisma.document.findUnique({
      where: { id: documentId }
    });
    
    if (!document) return res.status(404).json({ error: 'Document not found' });

    // Validate the user actually has access to this document's workspace
    const membership = await prisma.workspaceMember.findUnique({
      where: { userId_workspaceId: { userId, workspaceId: document.workspaceId } }
    });
    if (!membership) return res.status(403).json({ error: 'Forbidden' });

    res.json(document);
  } catch (error) {
    res.status(500).json({ error: 'Failed to load document' });
  }
});

// Create a new document in a workspace
router.post('/workspace/:workspaceId', authenticateJWT, requireRole(['ADMIN', 'EDITOR']), async (req: AuthRequest, res) => {
  const { workspaceId } = req.params;
  const { title, data } = req.body;
  const userId = req.user?.id;

  try {
    const document = await prisma.document.create({
      data: {
        title: title || 'Untitled Drawing',
        data: typeof data === 'string' ? data : JSON.stringify(data),
        workspaceId,
        authorId: userId,
      }
    });
    res.status(201).json(document);
  } catch (error) {
    res.status(500).json({ error: 'Failed to create document' });
  }
});

// Update an existing document (Save)
router.put('/:documentId', authenticateJWT, async (req: AuthRequest, res) => {
  const { documentId } = req.params;
  const { data, title } = req.body;
  const userId = req.user?.id;

  try {
    const document = await prisma.document.findUnique({ where: { id: documentId } });
    if (!document) return res.status(404).json({ error: 'Document not found' });

    // Validate role
    const membership = await prisma.workspaceMember.findUnique({
      where: { userId_workspaceId: { userId, workspaceId: document.workspaceId } }
    });
    if (!membership || membership.role === 'VIEWER') return res.status(403).json({ error: 'Forbidden' });

    const updated = await prisma.document.update({
      where: { id: documentId },
      data: {
        data: typeof data === 'string' ? data : JSON.stringify(data),
        ...(title ? { title } : {})
      }
    });
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update document' });
  }
});

export default router;
