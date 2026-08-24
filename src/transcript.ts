import axios from "axios";

const ghlApiToken = process.env.GHL_API_TOKEN;
const ghlLocationId = process.env.GHL_LOCATION_ID;

const ghlHeaders = {
  Authorization: `Bearer ${ghlApiToken}`,
  Version: "2021-07-28",
  "Content-Type": "application/json",
};

interface TranscriptLogInput {
  transcript: string;
  phone: string;
}

export async function logTranscriptToGhl(
  { transcript, phone }: TranscriptLogInput,
  recordingUrl: string
): Promise<void> {
  if (!phone) {
    phone = "Unknown Phone";
  }

  if (!transcript) {
    console.error("logTranscriptToGhl: missing transcript");
    return;
  }

  const upsert = await axios.post(
    "https://services.leadconnectorhq.com/contacts/upsert",
    { locationId: ghlLocationId, phone },
    { headers: ghlHeaders, timeout: 20000 }
  );

  const contactId = upsert.data?.contact?.id;
  if (!contactId) {
    console.error(
      "logTranscriptToGhl: could not resolve contactId from upsert"
    );
    return;
  }

  await axios.post(
    "https://services.leadconnectorhq.com/conversations/messages",
    {
      type: "Call",
      contactId,
      direction: "inbound",
      message: `${transcript}\n\nRecording: ${recordingUrl}\nPhone: ${phone}`,
    },
    { headers: ghlHeaders, timeout: 20000 }
  );
}
