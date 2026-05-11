import type { FastifyInstance } from "fastify";

import type { UploadImageResponse } from "@agentmesh/shared";

import { RequestValidationError } from "../errors.js";
import {
  ImageUploadService,
  MAX_IMAGE_BYTES,
  validateImageMimeType,
  validateUploadedFilename
} from "../services/image-uploads.js";

export async function registerUploadRoutes(app: FastifyInstance): Promise<void> {
  const service = new ImageUploadService(app.database, app.config);

  app.post("/api/uploads/images", async (request, reply): Promise<UploadImageResponse> => {
    if (!request.isMultipart()) {
      throw new RequestValidationError("Expected multipart image upload");
    }

    const file = await request.file({
      limits: { files: 1, fileSize: MAX_IMAGE_BYTES },
      throwFileSizeLimit: true
    });

    if (file === undefined) {
      throw new RequestValidationError("Missing image file");
    }

    validateUploadedFilename(file.filename);
    validateImageMimeType(file.mimetype);

    let buffer: Buffer;
    try {
      buffer = await file.toBuffer();
    } catch (error) {
      if (error instanceof app.multipartErrors.RequestFileTooLargeError) {
        throw new RequestValidationError("Image exceeds maximum size");
      }

      throw error;
    }

    const response = { attachment: service.storeUpload({ buffer, mimeType: file.mimetype }) };
    reply.code(201);
    return response;
  });
}
