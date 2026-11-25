import { api } from "../api.js";

/**
 * Creates a record from a name typed into a form, so contributors can start
 * an archive by typing names without opening a form for each one. A new
 * character, server, or event also gets a low-priority card on the research
 * board, so it is easy to find and fill in later, or merge if the name was a
 * misspelling. Channels and group chats get no card, because the board has
 * no cards about them.
 */

/** The board card field that marks a record created from a typed name. */
export const TO_FILL_IN = "profile";

export type QuickKind = "character" | "server" | "group_chat" | "event";

export interface Created {
  id: string;
  label: string;
}

async function flag(
  archiveId: string,
  subjectKind: "character" | "server" | "event",
  subjectId: string,
) {
  // The record exists either way, so a card that cannot be added is not worth failing over.
  await api(`/api/archives/${archiveId}/backlog/flags`, {
    method: "POST",
    json: {
      kind: "custom",
      subjectKind,
      subjectId,
      field: TO_FILL_IN,
      reason: "Added from a typed name. Fill in the rest, or merge it if it is a duplicate.",
    },
  }).catch(() => undefined);
}

export async function createNamed(
  archiveId: string,
  kind: Exclude<QuickKind, "event">,
  name: string,
): Promise<Created> {
  const base = `/api/archives/${archiveId}/entities`;
  const label = name.trim();
  if (kind === "character") {
    const created = await api<{ id: string }>(`${base}/character`, {
      method: "POST",
      json: { knownName: label },
    });
    await flag(archiveId, "character", created.id);
    return { id: created.id, label };
  }
  if (kind === "server") {
    const created = await api<{ id: string }>(`${base}/server`, {
      method: "POST",
      json: { label },
    });
    await flag(archiveId, "server", created.id);
    return { id: created.id, label };
  }
  const created = await api<{ id: string }>(`${base}/channel`, {
    method: "POST",
    json: { kind: "group_chat", label },
  });
  return { id: created.id, label };
}

/** A channel in a server, named as typed without a leading `#`. */
export async function createChannel(
  archiveId: string,
  serverId: string,
  name: string,
): Promise<Created> {
  const label = name.trim().replace(/^#/, "");
  const created = await api<{ id: string }>(`/api/archives/${archiveId}/entities/channel`, {
    method: "POST",
    json: { kind: "guild_channel", label, serverId },
  });
  return { id: created.id, label };
}

/**
 * An event from a typed title and the day it happened, which every event
 * needs. The day is marked estimated and the title doubles as the
 * description until someone fills it in.
 */
export async function createEvent(archiveId: string, title: string, day: string): Promise<Created> {
  const label = title.trim();
  const created = await api<{ id: string }>(`/api/archives/${archiveId}/events`, {
    method: "POST",
    json: {
      title: label,
      description: label,
      dateKind: "single",
      certainty: "estimated",
      start: day,
    },
  });
  await flag(archiveId, "event", created.id);
  return { id: created.id, label };
}
