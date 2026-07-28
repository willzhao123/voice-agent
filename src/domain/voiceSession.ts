export type VoiceSessionStatus = "active" | "closed";

export interface VoiceSession {
  readonly id: string;
  readonly status: VoiceSessionStatus;
  readonly startedAt: Date;
  readonly endedAt?: Date;
}

export function createVoiceSession(
  id: string,
  startedAt = new Date(),
): VoiceSession {
  return {
    id,
    status: "active",
    startedAt,
  };
}

export function closeVoiceSession(
  session: VoiceSession,
  endedAt = new Date(),
): VoiceSession {
  if (session.status === "closed") {
    return session;
  }

  return {
    ...session,
    status: "closed",
    endedAt,
  };
}
