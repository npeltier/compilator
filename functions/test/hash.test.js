import fs from "fs";
import crypto from "crypto";
import path from "path";
import {fileURLToPath} from "url";
import {jest} from "@jest/globals";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Mock music-metadata
jest.unstable_mockModule("music-metadata", () => ({
  parseFile: jest.fn(),
}));

// Dynamic imports after mocking
const musicMetadata = await import("music-metadata");
const {computeMp3Hash} = await import("../hash/hash.js");

describe("computeMp3Hash", () => {
  const testFilePath = path.join(__dirname, "test.mp3");
  const mockId3v2Size = 128;
  const mockAudioContent = Buffer.from("fake audio data for testing");
  const mockFileBuffer = Buffer.concat([
    Buffer.alloc(mockId3v2Size), // Simulated ID3v2 tag
    mockAudioContent,
  ]);

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(fs, "readFileSync").mockReturnValue(mockFileBuffer);
    musicMetadata.parseFile.mockResolvedValue({
      format: {id3v2Size: mockId3v2Size},
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("should return SHA-256 hash of audio data (no ID3v2 tags)", async () => {
    const expectedHash = crypto
        .createHash("sha256")
        .update(mockAudioContent)
        .digest("hex");

    const result = await computeMp3Hash(testFilePath);

    expect(result).toBe(expectedHash);
    expect(musicMetadata.parseFile).toHaveBeenCalledWith(testFilePath);
    expect(fs.readFileSync).toHaveBeenCalledWith(testFilePath);
  });

  it("should handle files with no ID3v2 tags (tagSize = 0)", async () => {
    musicMetadata.parseFile.mockResolvedValue({
      format: {id3v2Size: 0},
    });
    const fullFileBuffer = Buffer.from("audio only no tags");
    fs.readFileSync.mockReturnValue(fullFileBuffer);

    const expectedHash = crypto
        .createHash("sha256")
        .update(fullFileBuffer)
        .digest("hex");

    const result = await computeMp3Hash(testFilePath);

    expect(result).toBe(expectedHash);
  });

  it("should propagate errors from music-metadata", async () => {
    const error = new Error("Invalid MP3 file");
    musicMetadata.parseFile.mockRejectedValue(error);

    await expect(computeMp3Hash(testFilePath))
        .rejects.toThrow("Invalid MP3 file");
  });
});
