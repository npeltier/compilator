
import { onRequest } from 'firebase-functions/v2/https';
import { handleUpload } from './upload.js';

// This is the main entry point for the Firebase Function.
// It is configured to accept a raw request body for file uploads.
export const upload = onRequest(
  { rawBody: true },
  handleUpload
);
