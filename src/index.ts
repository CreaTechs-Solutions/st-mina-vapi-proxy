import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import { v2 as cloudinary, type UploadApiResponse } from "cloudinary";
import { logTranscriptToGhl } from "./transcript.js";

dotenv.config();

// GHL builds the body by interpolating {{transcript}} into a JSON template, so
// transcripts arrive with raw newlines inside a string literal — illegal JSON,
// which made express.json() reject the request before the route ran. Escape
// control characters found inside strings only; newlines between tokens are
// legal and must be left alone.
function parseJsonLoose(raw: string): unknown {
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    // fall through and repair
  }

  let out = "";
  let inString = false;
  let escaped = false;

  for (const char of raw) {
    const code = char.charCodeAt(0);
    if (escaped) {
      out += char;
      escaped = false;
    } else if (code === 92) {
      out += char;
      escaped = true;
    } else if (char === '"') {
      inString = !inString;
      out += char;
    } else if (inString && code < 0x20) {
      out += JSON.stringify(char).slice(1, -1);
    } else {
      out += char;
    }
  }

  return JSON.parse(out);
}

const app = express();
app.use(express.text({ type: () => true, limit: "10mb" }));
app.use((req, res, next) => {
  try {
    req.body = typeof req.body === "string" ? parseJsonLoose(req.body) : {};
    next();
  } catch {
    res.status(400).json({ error: "Malformed request body" });
  }
});

const PORT = process.env.PORT || 3000;
const VAPI_API_KEY = process.env.VAPI_API_KEY;
const PROXY_SECRET = process.env.PROXY_SECRET;

const CLOUDINARY_UPLOAD_PRESET = process.env.CLOUDINARY_UPLOAD_PRESET;

let cloudinaryReady = false;

// Configured lazily: on serverless, throwing at module load kills the whole
// function, so a missing credential should only fail the route that needs it.
function configureCloudinary(): void {
  if (cloudinaryReady) return;

  const cloud_name = process.env.CLOUDINARY_CLOUD_NAME;
  const api_key = process.env.CLOUDINARY_API_KEY;
  const api_secret = process.env.CLOUDINARY_API_SECRET;

  const missing = [
    ["CLOUDINARY_CLOUD_NAME", cloud_name],
    ["CLOUDINARY_API_KEY", api_key],
    ["CLOUDINARY_API_SECRET", api_secret],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length) {
    throw new Error(
      `Missing Cloudinary environment variables: ${missing.join(", ")}`
    );
  }

  cloudinary.config({
    cloud_name: cloud_name as string,
    api_key: api_key as string,
    api_secret: api_secret as string,
    secure: true,
  });

  cloudinaryReady = true;
}

app.get("/", (_req, res) => res.send("Hello"));

app.post("/recording", async (req, res) => {
  const { callId, token } = req.query;

  if (token !== PROXY_SECRET) {
    return res.status(403).json({ error: "Forbidden" });
  }

  if (!callId) {
    return res.status(400).send("Missing callId");
  }

  try {
    configureCloudinary();

    console.log(`https://api.vapi.ai/call/${callId}`);

    const call = await axios.get(`https://api.vapi.ai/call/${callId}`, {
      headers: { Authorization: `Bearer ${VAPI_API_KEY}` },
      timeout: 120000,
    });

    const recordingUrl = call.data.artifact?.presignedStereoUrl;

    console.log("Call data:", recordingUrl);

    if (!recordingUrl) {
      return res.status(404).send("No recording found for this call");
    }

    const file = await axios.get(recordingUrl, { responseType: "arraybuffer" });
    const audioBuffer = Buffer.from(file.data);

    const cloudinaryResult = await new Promise<UploadApiResponse>(
      (resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          {
            resource_type: "video",
            ...(CLOUDINARY_UPLOAD_PRESET
              ? { upload_preset: CLOUDINARY_UPLOAD_PRESET }
              : {}),
          },
          (error, result) =>
            error || !result
              ? reject(
                  error ?? new Error("Cloudinary upload returned no result")
                )
              : resolve(result)
        );
        stream.end(audioBuffer);
      }
    );

    try {
      await logTranscriptToGhl(req.body, cloudinaryResult.secure_url);
    } catch (error) {
      console.error("Error logging transcript to GHL:", error);
    }

    return res.json({ recordingUrl: cloudinaryResult.secure_url });
  } catch (err) {
    const status = axios.isAxiosError(err) ? err.response?.status ?? 500 : 500;
    const message = err instanceof Error ? err.message : String(err);
    console.error("Proxy error:", status, message);
    return res.status(status).send("Could not fetch recording");
  }
});

app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
