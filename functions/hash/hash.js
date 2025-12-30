import fs from "fs";
import crypto from "crypto";
import * as musicMetadata from "music-metadata";

async function computeMp3Hash(filePath) {
  const metadata = await musicMetadata.parseFile(filePath);
  const tagSize = metadata.format.id3v2Size;

  const fileBuffer = fs.readFileSync(filePath);
  const audioData = fileBuffer.subarray(tagSize);

  const hash = crypto.createHash("sha256");
  hash.update(audioData);

  return hash.digest("hex");
}

export {computeMp3Hash};

// CLI execution
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  const filePath = process.argv[2];
  computeMp3Hash(filePath)
      .then((hash) => console.log(hash))
      .catch((err) => console.error(err));
}
