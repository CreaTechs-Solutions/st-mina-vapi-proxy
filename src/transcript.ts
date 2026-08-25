import axios from "axios";

const ghlBaseUrl = "https://services.leadconnectorhq.com";

interface TranscriptLogInput {
  transcript: string;
  phone: string;
}

// GHL interpolates {{transcript}} into a JSON template, so depending on how the
// workflow escapes the value we receive either real newlines or the literal
// two-character sequence \n. GHL's conversation view renders the latter as-is,
// which is why a logged call reads "...today?\nUser: Hello." on a single line.
// Turn the escaped forms back into real breaks and strip the template's own
// padding so every shape of input produces one turn per line. Turns are then
// separated by a blank line, and the whole transcript opens with one, so the
// conversation view doesn't run the first turn up against the message header.
function normalizeTranscript(transcript: string): string {
  const turns = transcript
    .replace(/\\r\\n|\\n|\\r/g, "\n")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  return turns.length ? `\n${turns.join("\n\n")}` : "";
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

  const normalizedTranscript = normalizeTranscript(transcript ?? "");

  if (!normalizedTranscript) {
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
    `${ghlBaseUrl}/contacts/upsert`,
    { locationId: ghlLocationId, phone: normalizedPhone },
    { headers: ghlHeaders, timeout: 20000 }
  );

  const contactId = upsert.data?.contact?.id;
  if (!contactId) {
    console.error("logTranscriptToGhl: could not resolve contactId from upsert");
    return;
  }

  const search = await axios.get(`${ghlBaseUrl}/conversations/search`, {
    headers: ghlHeaders,
    params: { locationId: ghlLocationId, contactId, limit: 20 },
    timeout: 20000,
  });

  // GHL keeps one conversation per contact, so this is that contact's own
  // thread. It only needs creating when the contact has no history at all.
  let conversationId = search.data?.conversations?.[0]?.id;

  if (!conversationId) {
    const created = await axios.post(
      `${ghlBaseUrl}/conversations/`,
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
    `${ghlBaseUrl}/conversations/messages/inbound`,
    {
      type: "SMS",
      conversationId,
      contactId,
      direction: "inbound",
      message: normalizedTranscript,
      attachments: [recordingUrl],
    },
    { headers: ghlHeaders, timeout: 20000 }
  );

  console.log(
    `logTranscriptToGhl: logged to conversation ${conversationId} for contact ${contactId}`
  );
}
