import { createHash } from "node:crypto";

export function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function contentSha256(conversation) {
  return sha256(stableJson(conversation.mapping || {}));
}

export function attachmentReferenceCount(conversation) {
  let count = 0;
  for (const node of Object.values(conversation.mapping || {})) {
    const message = node?.message;
    if (!message) continue;
    count += Array.isArray(message.metadata?.attachments) ? message.metadata.attachments.length : 0;
    for (const part of message.content?.parts || []) {
      if (part && typeof part === "object"
        && (part.asset_pointer || part.content_type === "image_asset_pointer")) count++;
    }
  }
  return count;
}
