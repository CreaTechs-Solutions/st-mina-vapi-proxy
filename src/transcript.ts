import axios from "axios";

const GHL_BASE = "https://services.leadconnectorhq.com";

interface TranscriptLogInput {
  transcript: string;
  phone: string;
}

export async function logTranscriptToGhl(
  { transcript, phone }: TranscriptLogInput,
  recordingUrl: string
): Promise<void> {
  // Read inside the function: index.ts calls dotenv.config() in its module
  // body, which ESM runs after this module is evaluated, so a top-level read
  // captures undefined and sends "Authorization: Bearer undefined".
  const ghlApiToken = process.env.GHL_API_TOKEN;
  const ghlLocationId = process.env.GHL_LOCATION_ID;

  const ghlHeaders = {
    Authorization: `Bearer ${ghlApiToken}`,
    Version: "2021-07-28",
    "Content-Type": "application/json",
  };

  if (!ghlApiToken || !ghlLocationId) {
    console.error("logTranscriptToGhl: missing GHL env vars — skipping");
    return;
  }

  if (!transcript) {
    console.error("logTranscriptToGhl: missing transcript");
    return;
  }

  if (!phone) {
    console.error("logTranscriptToGhl: missing phone");
    return;
  }

  // GHL may send "+1 (813) 723 3747" while the contact is stored as
  // "+18137233747". Without this a known caller gets a duplicate contact,
  // and therefore a second thread, instead of matching their own.
  const digits = phone.replace(/\D/g, "");
  const normalizedPhone = digits.length === 10 ? `+1${digits}` : `+${digits}`;

  // Find the caller's contact, creating it if this number is new to the CRM.
  const upsert = await axios.post(
    `${GHL_BASE}/contacts/upsert`,
    { locationId: ghlLocationId, phone: normalizedPhone },
    { headers: ghlHeaders, timeout: 20000 }
  );

  const contactId = upsert.data?.contact?.id;
  if (!contactId) {
    console.error("logTranscriptToGhl: could not resolve contactId from upsert");
    return;
  }

  const search = await axios.get(`${GHL_BASE}/conversations/search`, {
    headers: ghlHeaders,
    params: { locationId: ghlLocationId, contactId, limit: 20 },
    timeout: 20000,
  });

  // GHL keeps one conversation per contact, so this is that contact's own
  // thread. It only needs creating when the contact has no history at all.
  let conversationId = search.data?.conversations?.[0]?.id;

  if (!conversationId) {
    const created = await axios.post(
      `${GHL_BASE}/conversations/`,
      { locationId: ghlLocationId, contactId },
      { headers: ghlHeaders, timeout: 20000 }
    );
    conversationId = created.data?.conversation?.id ?? created.data?.id;
  }

  if (!conversationId) {
    console.error("logTranscriptToGhl: could not resolve or create conversation");
    return;
  }

  await axios.post(
    `${GHL_BASE}/conversations/messages/inbound`,
    {
      type: "SMS",
      conversationId,
      contactId,
      direction: "inbound",
      message: transcript,
      attachments: [recordingUrl],
    },
    { headers: ghlHeaders, timeout: 20000 }
  );

  console.log(
    `logTranscriptToGhl: logged to conversation ${conversationId} for contact ${contactId}`
  );
}
