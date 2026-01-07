
import Busboy from 'busboy';
import os from 'os';
import fs from 'fs';
import path from 'path';

import admin from 'firebase-admin';
import { processCompilation } from './processing.js';

// Initialize Firebase Admin SDK if not already initialized
if (admin.apps.length === 0) {
  admin.initializeApp();
}

/**
 * Handles the entire song upload and processing workflow.
 * @param {import('firebase-functions/v2/https').Request} req The request object.
 * @param {import('firebase-functions/v2/https').Response} res The response object.
 */
export const handleUpload = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  // --- START AUTHENTICATION ---
  const idToken = req.headers.authorization?.split('Bearer ')[1];

  if (!idToken) {
    return res.status(401).send('Unauthorized: No token provided.');
  }

  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    req.user = decodedToken; // Attach user info to the request
  } catch (error) {
    console.error('Error verifying Firebase ID token:', error);
    return res.status(401).send('Unauthorized: Invalid token.');
  }
  // --- END AUTHENTICATION ---

  const busboy = Busboy({ headers: req.headers });
  const tmpdir = os.tmpdir();
  const compilationRequest = {
      authorId: req.user.uid, // Add authorId from the token
  };
  let filepath;

  busboy.on('file', (fieldname, file, info) => {
    const { filename } = info;
    console.log(`File [${fieldname}]: filename: ${filename}`);
    filepath = path.join(tmpdir, filename);
    const writeStream = fs.createWriteStream(filepath);
    file.pipe(writeStream);
    compilationRequest.filepath = filepath;
  });

  busboy.on('field', (fieldname, val) => {
    console.log(`Field [${fieldname}]: value: ${val}`);
    if (fieldname === 'author') {
      compilationRequest.author = val;
    }
  });

  busboy.on('finish', async () => {
    console.log('Finished parsing form.');
    try {
      const compilation = await processCompilation(compilationRequest);
      res.status(200).json(compilation);
    } catch (error) {
      console.error('Error processing uploads:', error);
      res.status(500).send('Internal Server Error');
    }
  });

  bus.end(req.rawBody);
};
