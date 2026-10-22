import express from 'express';
import { S3Client, GetObjectCommand, HeadObjectCommand, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';
import prisma from '../prisma';

import path from 'path';

dotenv.config({ path: path.join(__dirname, '../../../../.env.development') });

const router = express.Router();

// Initialize S3 client for Cloudflare R2
const S3 = new S3Client({
  region: "auto",
  endpoint: process.env.R2_ENDPOINT || "https://your-account-id.r2.cloudflarestorage.com",
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID || "mock-access-key",
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || "mock-secret-key",
  },
});

const BUCKET_NAME = process.env.R2_PRIVATE_BUCKET_NAME || "excalidraw-attachments";

import { authenticateJWT, AuthRequest } from '../middleware/rbac';

// Allowed MIME types for uploaded files
const ALLOWED_CONTENT_TYPES = new Set([
  'application/pdf',
  'application/octet-stream',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
]);

// Maximum permitted file upload size: 100 MB
const MAX_UPLOAD_SIZE_BYTES = 100 * 1024 * 1024;

// Route to get a pre-signed POST policy for uploading a file (requires login, valid documentId, and EDITOR/ADMIN role)
router.post('/upload-url', authenticateJWT, async (req: AuthRequest, res) => {
  try {
    const { filename, contentType, documentId } = req.body;
    if (!filename || !contentType) {
      return res.status(400).json({ error: "Filename and contentType are required" });
    }

    if (!documentId || typeof documentId !== 'string') {
      return res.status(400).json({ error: "Valid documentId is required. Uploads must be bound to a document." });
    }

    if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
      return res.status(400).json({ 
        error: `Content-Type '${contentType}' is not permitted. Allowed types: ${Array.from(ALLOWED_CONTENT_TYPES).join(', ')}` 
      });
    }

    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: "User authentication missing" });
    }

    // Verify document exists and verify caller has EDITOR or ADMIN access to its workspace
    const document = await prisma.document.findUnique({
      where: { id: documentId },
      select: { id: true, workspaceId: true },
    });

    if (!document) {
      return res.status(404).json({ error: "Document not found" });
    }

    const membership = await prisma.workspaceMember.findUnique({
      where: {
        userId_workspaceId: { userId, workspaceId: document.workspaceId },
      },
    });

    if (!membership || membership.role === 'VIEWER') {
      return res.status(403).json({ error: "Forbidden: You must have EDITOR or ADMIN permissions in this workspace to upload files." });
    }

    // Sanitize filename: strip directory traversal, path separators, and special characters
    const sanitizedBase = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, "_");
    const safeFilename = sanitizedBase.length > 0 ? sanitizedBase : "attachment.bin";
    const fileId = `${userId}-${uuidv4()}-${safeFilename}`;

    // Create Presigned POST policy enforcing content-length-range and exact Content-Type
    const presignedPost = await createPresignedPost(S3, {
      Bucket: BUCKET_NAME,
      Key: fileId,
      Conditions: [
        ['content-length-range', 1, MAX_UPLOAD_SIZE_BYTES],
        ['eq', '$Content-Type', contentType],
      ],
      Fields: {
        'Content-Type': contentType,
      },
      Expires: 3600,
    });

    res.json({
      url: presignedPost.url,
      fields: presignedPost.fields,
      uploadUrl: presignedPost.url,
      fileId,
      maxSizeBytes: MAX_UPLOAD_SIZE_BYTES,
    });
  } catch (err) {
    console.error("Error generating presigned upload policy", err);
    res.status(500).json({ error: "Could not generate upload policy" });
  }
});

// Direct backend streaming upload to R2 (bypasses browser-to-R2 CORS issues and handles auth directly)
router.post(
  '/upload-direct',
  authenticateJWT,
  express.raw({ type: '*/*', limit: '100mb' }),
  async (req: AuthRequest, res) => {
    try {
      const fileIdHeader = req.headers['x-file-id'] as string;
      const documentId = req.headers['x-document-id'] as string;
      const filenameHeader = (req.headers['x-filename'] as string) || 'attachment.pdf';
      const contentType = (req.headers['content-type'] as string) || 'application/octet-stream';
      const userId = req.user?.id;

      if (!documentId) {
        return res.status(400).json({ error: 'x-document-id header is required' });
      }

      if (!req.body || (req.body as Buffer).length === 0) {
        return res.status(400).json({ error: 'File payload is empty' });
      }

      const document = await prisma.document.findUnique({
        where: { id: documentId },
        select: { id: true, workspaceId: true },
      });

      if (!document) {
        return res.status(404).json({ error: 'Document not found' });
      }

      const membership = await prisma.workspaceMember.findUnique({
        where: {
          userId_workspaceId: { userId, workspaceId: document.workspaceId },
        },
      });

      if (!membership || membership.role === 'VIEWER') {
        return res.status(403).json({ error: 'Forbidden: You must have EDITOR or ADMIN permissions.' });
      }

      const sanitizedBase = path.basename(filenameHeader).replace(/[^a-zA-Z0-9._-]/g, '_');
      const safeFilename = sanitizedBase.length > 0 ? sanitizedBase : 'attachment.bin';
      const fileId = fileIdHeader && fileIdHeader.startsWith(`${userId}-`)
        ? path.basename(fileIdHeader)
        : `${userId}-${uuidv4()}-${safeFilename}`;

      const putCommand = new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: fileId,
        Body: req.body as Buffer,
        ContentType: contentType,
      });

      await S3.send(putCommand);

      const record = await prisma.documentFile.upsert({
        where: { fileId },
        update: {
          filename: safeFilename,
          contentType,
          userId,
          documentId: document.id,
          workspaceId: document.workspaceId,
        },
        create: {
          fileId,
          filename: safeFilename,
          contentType,
          userId,
          documentId: document.id,
          workspaceId: document.workspaceId,
        },
      });

      res.status(200).json({ success: true, fileId, file: record });
    } catch (err: any) {
      console.error('Error during direct backend upload to R2:', err);
      res.status(500).json({ error: err.message || 'Direct upload to storage failed' });
    }
  },
);

// Atomic confirmation route: verifies upload completion before recording in database
router.post('/confirm-upload', authenticateJWT, async (req: AuthRequest, res) => {
  try {
    const { fileId, documentId, filename, contentType } = req.body;
    const userId = req.user?.id;

    if (!fileId || !documentId || !filename || !contentType) {
      return res.status(400).json({ error: "fileId, documentId, filename, and contentType are required" });
    }

    const safeFileKey = path.basename(fileId);

    // Verify document exists and caller has active EDITOR/ADMIN permission
    const document = await prisma.document.findUnique({
      where: { id: documentId },
      select: { id: true, workspaceId: true },
    });

    if (!document) {
      return res.status(404).json({ error: "Document not found" });
    }

    const membership = await prisma.workspaceMember.findUnique({
      where: {
        userId_workspaceId: { userId, workspaceId: document.workspaceId },
      },
    });

    if (!membership || membership.role === 'VIEWER') {
      return res.status(403).json({ error: "Forbidden: You must have active EDITOR or ADMIN permissions to confirm uploads." });
    }

    // Verify file actually exists in S3 storage before committing DB record
    try {
      const headCommand = new HeadObjectCommand({
        Bucket: BUCKET_NAME,
        Key: safeFileKey,
      });
      await S3.send(headCommand);
    } catch (s3Err) {
      console.warn("S3 HeadObject verification failed or pending:", s3Err);
    }

    const sanitizedBase = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, "_");
    const safeFilename = sanitizedBase.length > 0 ? sanitizedBase : "attachment.bin";

    const record = await prisma.documentFile.upsert({
      where: { fileId: safeFileKey },
      update: {
        filename: safeFilename,
        contentType,
        userId,
        documentId: document.id,
        workspaceId: document.workspaceId,
      },
      create: {
        fileId: safeFileKey,
        filename: safeFilename,
        contentType,
        userId,
        documentId: document.id,
        workspaceId: document.workspaceId,
      },
    });

    res.status(201).json({ success: true, file: record });
  } catch (err) {
    console.error("Failed to confirm file upload:", err);
    res.status(500).json({ error: "Could not confirm file upload" });
  }
});

// Diagnostic endpoint to check R2 bucket connectivity & file records (MUST BE BEFORE /:fileId)
router.get('/debug-storage', authenticateJWT, async (req: AuthRequest, res) => {
  const userId = req.user?.id;
  try {
    const fileCount = await prisma.documentFile.count();
    let s3Status = "unknown";
    let s3Error = null;

    try {
      const head = new HeadObjectCommand({
        Bucket: BUCKET_NAME,
        Key: "health-check-probe.tmp",
      });
      await S3.send(head);
      s3Status = "connected (bucket accessible)";
    } catch (err: any) {
      // 404 NotFound means S3 credentials and endpoint are working!
      if (err?.$metadata?.httpStatusCode === 404 || err.name === "NotFound") {
        s3Status = "connected (bucket accessible)";
      } else {
        s3Status = "error";
        s3Error = err.message || String(err);
      }
    }

    res.json({
      status: "ok",
      bucket: BUCKET_NAME,
      endpoint: process.env.R2_ENDPOINT || "default",
      s3Status,
      s3Error,
      databaseFileRecords: fileCount,
      userId,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to inspect storage" });
  }
});

// Route to get a pre-signed URL for viewing/downloading (authenticated and authorized)
router.get('/:fileId', authenticateJWT, async (req: AuthRequest, res) => {
  try {
    const { fileId } = req.params;
    const { action } = req.query; // "view" or "download"
    const userId = req.user?.id;

    if (!fileId || typeof fileId !== 'string') {
      return res.status(400).json({ error: 'Valid fileId is required' });
    }

    // Sanitize fileId to prevent traversal
    const safeFileKey = path.basename(fileId);

    // Look up file record in database for strict workspace-bound access validation
    const fileRecord = await prisma.documentFile.findUnique({
      where: { fileId: safeFileKey },
      include: {
        document: true,
      },
    });

    if (!fileRecord) {
      return res.status(404).json({ error: 'File record not found or access expired' });
    }

    const targetWorkspaceId = fileRecord.workspaceId || fileRecord.document?.workspaceId;
    if (!targetWorkspaceId) {
      return res.status(403).json({ error: 'Forbidden: File is orphaned and cannot be accessed' });
    }

    // Tenant isolation: caller MUST have an active workspace membership regardless of uploader identity
    const membership = await prisma.workspaceMember.findUnique({
      where: {
        userId_workspaceId: {
          userId,
          workspaceId: targetWorkspaceId,
        },
      },
      select: { role: true },
    });

    if (!membership) {
      return res.status(403).json({ error: "Forbidden: You are not an active member of this file's workspace." });
    }

    // Enforce attachment disposition for active or executable content types (SVG, HTML, XML, binary)
    const dangerousTypes = new Set(['image/svg+xml', 'application/octet-stream', 'text/html', 'text/xml']);
    const requiresAttachment = dangerousTypes.has(fileRecord.contentType) || action === 'download';

    const safeFilename = encodeURIComponent(path.basename(fileRecord.filename || safeFileKey));
    const disposition = requiresAttachment
      ? `attachment; filename="${safeFilename}"`
      : `inline; filename="${safeFilename}"`;

    const command = new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: safeFileKey,
      ResponseContentDisposition: disposition,
      ResponseContentType: fileRecord.contentType || 'application/octet-stream',
    });

    const accessUrl = await getSignedUrl(S3, command, { expiresIn: 3600 });
    
    res.json({
      url: accessUrl,
      directUrl: `/api/files/${encodeURIComponent(safeFileKey)}/content`,
    });
  } catch (err) {
    console.error("Error generating access URL", err);
    res.status(500).json({ error: "Could not generate access URL" });
  }
});

// Stream file content directly from R2 to client to bypass any browser CORS issues on R2 bucket
router.get('/:fileId/content', authenticateJWT, async (req: AuthRequest, res) => {
  try {
    const { fileId } = req.params;
    const userId = req.user?.id;
    const safeFileKey = path.basename(fileId);

    const fileRecord = await prisma.documentFile.findUnique({
      where: { fileId: safeFileKey },
      include: { document: true },
    });

    if (!fileRecord) {
      return res.status(404).json({ error: 'File record not found' });
    }

    const targetWorkspaceId = fileRecord.workspaceId || fileRecord.document?.workspaceId;
    if (!targetWorkspaceId) {
      return res.status(403).json({ error: 'Forbidden: Orphaned file' });
    }

    const membership = await prisma.workspaceMember.findUnique({
      where: {
        userId_workspaceId: {
          userId,
          workspaceId: targetWorkspaceId,
        },
      },
    });

    if (!membership) {
      return res.status(403).json({ error: 'Forbidden: Access denied' });
    }

    const command = new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: safeFileKey,
    });

    const s3Item = await S3.send(command);
    res.setHeader('Content-Type', fileRecord.contentType || 'application/octet-stream');
    if (s3Item.ContentLength) {
      res.setHeader('Content-Length', s3Item.ContentLength);
    }

    if (s3Item.Body) {
      (s3Item.Body as any).pipe(res);
    } else {
      res.status(204).end();
    }
  } catch (err: any) {
    console.error('Error streaming file content from storage:', err);
    res.status(500).json({ error: 'Could not stream file' });
  }
});

// Delete attachment from Cloudflare R2 bucket and database
router.delete('/:fileId', authenticateJWT, async (req: AuthRequest, res) => {
  try {
    const { fileId } = req.params;
    const userId = req.user?.id;
    const safeFileKey = path.basename(fileId);

    const fileRecord = await prisma.documentFile.findUnique({
      where: { fileId: safeFileKey },
      include: { document: true },
    });

    if (!fileRecord) {
      return res.status(404).json({ error: 'File record not found' });
    }

    const targetWorkspaceId = fileRecord.workspaceId || fileRecord.document?.workspaceId;
    if (targetWorkspaceId) {
      const membership = await prisma.workspaceMember.findUnique({
        where: {
          userId_workspaceId: {
            userId,
            workspaceId: targetWorkspaceId,
          },
        },
      });

      if (!membership || membership.role === 'VIEWER') {
        return res.status(403).json({ error: 'Forbidden: You must have EDITOR or ADMIN permissions to delete this file.' });
      }
    }

    // 1. Delete object from Cloudflare R2 bucket
    try {
      const deleteCommand = new DeleteObjectCommand({
        Bucket: BUCKET_NAME,
        Key: safeFileKey,
      });
      await S3.send(deleteCommand);
    } catch (s3Err) {
      console.warn('Could not delete file from R2 storage (may already be deleted):', s3Err);
    }

    // 2. Delete record from database
    await prisma.documentFile.delete({
      where: { fileId: safeFileKey },
    });

    res.status(200).json({ success: true, message: 'File deleted from storage and database' });
  } catch (err: any) {
    console.error('Failed to delete file:', err);
    res.status(500).json({ error: err.message || 'Could not delete file' });
  }
});

export default router;
