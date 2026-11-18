import crypto from "node:crypto";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { ensure } from "./errors.js";

const s3 = new S3Client({ maxAttempts: 3 });
export class MediaService {
  constructor(client = s3) {
    this.client = client;
    this.cache = new Map();
  }
  async resolve(reference) {
    if (!reference?.startsWith("media:")) return reference || "";
    const key = reference.slice(6);
    ensure(
      /^app-media\/[^/]+\/[a-z0-9-]+\.(jpeg|png|webp)$/.test(key),
      "Invalid image reference.",
    );
    const cached = this.cache.get(key);
    if (cached && cached.expires > Date.now()) return cached.url;
    const bucket = process.env.MEDIA_BUCKET;
    ensure(bucket, "Image storage is not configured.", 503);
    const url = await getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: bucket, Key: key }),
      { expiresIn: 3600 },
    );
    if (this.cache.size > 500) this.cache.clear();
    this.cache.set(key, { url, expires: Date.now() + 45 * 60 * 1000 });
    return url;
  }
  async upload(uid, data) {
    const match =
      typeof data === "string" &&
      data.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
    ensure(match, "Choose a JPEG, PNG or WebP photo.");
    const bytes = Buffer.from(match[2], "base64");
    ensure(
      bytes.length > 0 && bytes.length <= 3 * 1024 * 1024,
      "The photo must be smaller than 3 MB.",
    );
    const mime = match[1],
      valid =
        mime === "image/jpeg"
          ? bytes[0] === 255 && bytes[1] === 216
          : mime === "image/png"
            ? bytes
                .subarray(0, 8)
                .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
            : bytes.subarray(0, 4).toString() === "RIFF" &&
              bytes.subarray(8, 12).toString() === "WEBP";
    ensure(valid, "The photo data does not match its image type.");
    const bucket = process.env.MEDIA_BUCKET;
    ensure(bucket, "Image storage is not configured.", 503);
    const key = `app-media/${uid}/${crypto.createHash("sha256").update(bytes).digest("hex")}.${mime.split("/")[1]}`;
    await this.client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: bytes,
        ContentType: mime,
        ServerSideEncryption: "AES256",
        CacheControl: "private, max-age=3600",
      }),
    );
    return {
      reference: `media:${key}`,
      url: await this.resolve(`media:${key}`),
    };
  }
}
