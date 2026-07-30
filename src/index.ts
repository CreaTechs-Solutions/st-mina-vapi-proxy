import express from "express";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const app = express();

const PORT = process.env.PORT || 3000;
const VAPI_API_KEY = process.env.VAPI_API_KEY;
const PROXY_SECRET = process.env.PROXY_SECRET;

app.get("/", (_req, res) => res.send("ok"));

app.get("/recording", async (req, res) => {
  const { callId, token } = req.query;

  if (token !== PROXY_SECRET) {
    return res.status(403).json({ error: "Forbidden" });
  }

  if (!callId) {
    return res.status(400).send("Missing callId");
  }

  try {
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

    return res.json({ recordingUrl });
  } catch (err: any) {
    const status = err.response?.status || 500;
    console.error("Proxy error:", status, err.message);
    return res.status(status).send("Could not fetch recording");
  }
});

app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
