
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
export const handleUpload = (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  const busboy = Busboy({ headers: req.headers });
  const tmpdir = os.tmpdir();
  const compilationRequest = {};

  busboy.on('file', (fieldname, file, info) => {
    const { filename } = info;
    console.log(`File [${fieldname}]: filename: ${filename}`);
    filepath = path.join(tmpdir, filename);
    const writeStream = fs.createWriteStream(filepath);
    file.pipe(writeStream);
    compilationRequest.filepath = { filepath };
  });

  busboy.on('author', (fieldname, val) => {
    console.log(`Field [${fieldname}]: value: ${val}`);
    compilationRequest.author = val;
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

  busboy.end(req.rawBody);
};
